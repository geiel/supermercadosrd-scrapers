import { inArray, sql } from "drizzle-orm";
import type { ShopPriceRow } from "./db/apply-scrape-result.js";
import { productsShopsPrices } from "./db/schema.js";
import {
  extractJumboSkuCandidates,
  extractNacionalSku,
} from "./recovery/shared.js";
import {
  extractMercaJumboSkuFromUrl,
  resolveMercaJumboApiUrl,
} from "./shops/merca-jumbo-shared.js";
import type { SirenaVtexProduct } from "./sirena-vtex.js";

// Shops priced by the batched sync instead of one request per product.
// Nacional (2), Jumbo (3) and Merca Jumbo (7) share one Magento backend.
export const BATCH_PRICE_SHOP_IDS = [1, 2, 3, 7] as const;
export type BatchPriceShopId = (typeof BATCH_PRICE_SHOP_IDS)[number];

const MAGENTO_BATCH_SHOP_IDS = [2, 3, 7] as const;

// Sirena rows whose API is a VTEX product slug ending in its reference
// (".../search/linda-habichuela-blanca-15-oz-1027594/p") or a VTEX product id
// (".../search?fq=productId:20960"). The same pattern runs in Postgres (~) and
// in JavaScript. Rows on the old st.sirena.do API stay in the per-product
// batch.
export const SIRENA_BATCH_API_PATTERN =
  "^https://www\\.sirena\\.do/api/catalog_system/pub/products/search(/[^/?#]+-[0-9]+/p|\\?fq=productId:[0-9]+)$";

const sirenaBatchApiRegex = new RegExp(SIRENA_BATCH_API_PATTERN);

// Rows the batched sync owns. The per-product batch and the deals job skip
// them, so no price is fetched twice.
export const batchPriceRowCondition = sql`(
  ${inArray(productsShopsPrices.shopId, [...MAGENTO_BATCH_SHOP_IDS])}
  or (
    ${productsShopsPrices.shopId} = 1
    and coalesce(${productsShopsPrices.api}, ${productsShopsPrices.url}) ~ ${SIRENA_BATCH_API_PATTERN}
  )
)`;

export type SirenaBatchReference =
  | { field: "alternateIds_RefId"; value: string; slug: string }
  | { field: "productId"; value: string };

export function parseSirenaBatchReference(
  row: Pick<ShopPriceRow, "api" | "url">
): SirenaBatchReference | null {
  // The single lookup requests `api ?? url`; the batch keys off the same value.
  const value = row.api ?? row.url;
  if (!sirenaBatchApiRegex.test(value)) {
    return null;
  }

  const slug = value.match(/\/search\/([^/?#]+)\/p$/)?.[1];
  if (slug) {
    return {
      field: "alternateIds_RefId",
      value: slug.match(/-([0-9]+)$/)![1],
      slug,
    };
  }

  return {
    field: "productId",
    value: value.match(/fq=productId:([0-9]+)$/)![1],
  };
}

export type BatchLookupKeys = {
  // Keys of one group go in the same request (one VTEX filter field, one
  // Magento endpoint).
  group: string;
  keys: string[];
};

// null means the row cannot be batched; it gets the single lookup, which
// reports the same error it reports today (bad URL, missing SKU).
export function batchLookupKeys(row: ShopPriceRow): BatchLookupKeys | null {
  switch (row.shopId) {
    case 1: {
      const reference = parseSirenaBatchReference(row);
      return reference
        ? { group: reference.field, keys: [reference.value] }
        : null;
    }
    case 2: {
      const sku = extractNacionalSku(row.url);
      return sku ? { group: "nacional", keys: [sku] } : null;
    }
    case 3: {
      const skus = extractJumboSkuCandidates(row.url);
      return skus.length > 0 ? { group: "jumbo", keys: skus } : null;
    }
    case 7: {
      const sku = extractMercaJumboSkuFromUrl(row.url);
      // Grouped by the endpoint the single lookup would call.
      return sku
        ? { group: `merca_jumbo:${resolveMercaJumboApiUrl(row.api) ?? ""}`, keys: [sku] }
        : null;
    }
    default:
      return null;
  }
}

export type BatchChunk = {
  group: string;
  keys: string[];
  rows: ShopPriceRow[];
};

// Packs rows into requests of at most maxKeys distinct keys, in row order
// (oldest price first), never mixing groups. Rows that share a key share the
// request.
export function chunkBatchRows(
  rows: Array<{ row: ShopPriceRow; lookup: BatchLookupKeys }>,
  maxKeys: number
): BatchChunk[] {
  const chunks: BatchChunk[] = [];
  const open = new Map<string, { keys: Set<string>; rows: ShopPriceRow[] }>();

  const close = (group: string) => {
    const chunk = open.get(group);
    if (chunk && chunk.rows.length > 0) {
      chunks.push({ group, keys: [...chunk.keys], rows: chunk.rows });
    }
    open.delete(group);
  };

  for (const { row, lookup } of rows) {
    let chunk = open.get(lookup.group);
    const newKeys = lookup.keys.filter((key) => !chunk?.keys.has(key));
    if (chunk && chunk.keys.size + newKeys.length > maxKeys) {
      close(lookup.group);
      chunk = undefined;
    }

    if (!chunk) {
      chunk = { keys: new Set(), rows: [] };
      open.set(lookup.group, chunk);
    }

    for (const key of lookup.keys) {
      chunk.keys.add(key);
    }
    chunk.rows.push(row);
  }

  for (const group of [...open.keys()]) {
    close(group);
  }

  return chunks;
}

// Splits a request that failed into two of about half the keys, so one
// product that breaks the store's query (Magento answers "Internal server
// error" for the whole batch) only fails its own row. null means the chunk
// is a single row and cannot be split further.
export function splitBatchChunk(chunk: BatchChunk): BatchChunk[] | null {
  if (chunk.rows.length < 2) {
    return null;
  }

  const halves = chunkBatchRows(
    chunk.rows.map((row) => ({ row, lookup: batchLookupKeys(row)! })),
    Math.ceil(chunk.keys.length / 2)
  );
  return halves.length > 1 ? halves : null;
}

function normalizeSlug(value: string) {
  try {
    return decodeURIComponent(value).trim().toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

// Picks the VTEX product each Sirena row asked for. A reference must also
// match the row's slug, as the single lookup by slug would: a reference that
// now points to another slug (or to several products) is left out, and the row
// falls back to that single lookup.
export function matchSirenaProducts(
  rows: ShopPriceRow[],
  products: SirenaVtexProduct[]
): Map<ShopPriceRow, SirenaVtexProduct> {
  const matches = new Map<ShopPriceRow, SirenaVtexProduct>();

  for (const row of rows) {
    const reference = parseSirenaBatchReference(row);
    if (!reference) {
      continue;
    }

    const candidates =
      reference.field === "productId"
        ? products.filter(
            (product) => String(product.productId) === reference.value
          )
        : products.filter(
            (product) =>
              (product.productReference ?? product.productReferenceCode) ===
                reference.value &&
              normalizeSlug(product.linkText ?? "") ===
                normalizeSlug(reference.slug)
          );

    if (candidates.length === 1) {
      matches.set(row, candidates[0]);
    }
  }

  return matches;
}

// Picks, for each row, the first of its SKU candidates the response listed:
// the order the single Jumbo lookup tries them in. A listed but malformed item
// (null) leaves the row out, so the single lookup reports it as it does today.
export function matchSkuItems<T>(
  rows: ShopPriceRow[],
  items: Map<string, T | null>
): Map<ShopPriceRow, T> {
  const matches = new Map<ShopPriceRow, T>();

  for (const row of rows) {
    const lookup = batchLookupKeys(row);
    const sku = lookup?.keys.find((key) => items.has(key));
    const item = sku === undefined ? null : items.get(sku);
    if (item) {
      matches.set(row, item);
    }
  }

  return matches;
}
