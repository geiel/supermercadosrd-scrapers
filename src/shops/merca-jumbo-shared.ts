import { z } from "zod";
import { dedupeComparableUrls, normalizeNacionalImageUrl } from "../image-utils.js";
import { fetchWithRetryDetailed } from "../http-client.js";
import type { FetchWithRetryConfig, ScrapeLocationAvailability } from "../types.js";
import { randomDelay } from "../utils.js";
import {
  magentoPurchaseTermsGraphqlFields,
  magentoPurchaseTermsGraphqlSchema,
  type MagentoGraphqlPurchaseFields,
} from "./magento-graphql-purchase-terms.js";
import {
  fetchMagentoGraphqlItemsBySku,
  type MagentoGraphqlBatchLookup,
  magentoOutOfStockOnline,
  magentoStockStatusSchema,
} from "./magento-graphql-batch.js";

const MERCA_JUMBO_API_URL_ENV = "MERCA_JUMBO_API_URL";
const MERCA_JUMBO_STORE_CODE_ENV = "MERCA_JUMBO_STORE_CODE";

const mercaJumboProductItemFields = `
      sku
      stock_status
      name
      url_key
${magentoPurchaseTermsGraphqlFields}
      image {
        url
      }
      small_image {
        url
      }
      price_range {
        minimum_price {
          final_price {
            value
          }
          regular_price {
            value
          }
        }
      }`;

const mercaJumboProductQuery = `query MercaJumboProductBySku($sku: String!) {
  products(filter: { sku: { eq: $sku } }) {
    items {${mercaJumboProductItemFields}
    }
  }
}`;

// Each branch's stock comes from SourceItems, one branch per field. Magento
// takes at most 10 aliases a query, so a request holds one unaliased field and
// 10 aliased: 11 branches beside the prices, and the rest (2 of 13 on
// 2026-11-26) in a second request. The batch sync asks 100 products at a time
// for Merca Jumbo, so this costs the same requests as prices alone at 50.
const SOURCES_PER_REQUEST = 11;

function sourceItemsFields(codes: string[]) {
  return codes
    .map(
      (code, index) =>
        `${index === 0 ? "" : `s${code}: `}SourceItems(source_code: "${code}", skus: $skus, pageSize: $pageSize) { items { sku quantity status } }`
    )
    .join("\n  ");
}

function mercaJumboProductsBySkuQuery(sourceCodes: string[]) {
  return `query MercaJumboProductsBySku($skus: [String!]!, $pageSize: Int!) {
  products(filter: { sku: { in: $skus } }, pageSize: $pageSize) {
    total_count
    items {${mercaJumboProductItemFields}
    }
  }
  ${sourceItemsFields(sourceCodes)}
}`;
}

const sourceItemsSchema = z.object({
  items: z
    .array(
      z.object({
        sku: z.string(),
        quantity: z.number().nullish(),
        status: z.number().nullish(),
      })
    )
    .nullish(),
});

type SourceItem = { code: string; sku: string; quantity: number | null; status: number | null };

/** The branch rows of these fields, or null when any field is missing (then no branch is known). */
function readSourceItems(data: Record<string, unknown>, codes: string[]): SourceItem[] | null {
  const rows: SourceItem[] = [];
  for (const [index, code] of codes.entries()) {
    const parsed = sourceItemsSchema.safeParse(data[index === 0 ? "SourceItems" : `s${code}`]);
    if (!parsed.success) return null;
    for (const item of parsed.data.items ?? []) {
      rows.push({ code, sku: item.sku, quantity: item.quantity ?? null, status: item.status ?? null });
    }
  }
  return rows;
}

const sourceCodesByStore = new Map<string, string[]>();

/** Merca Jumbo's branches (InventorySources), once per run; none when they can't be read. */
async function mercaJumboSourceCodes(
  apiUrl: string,
  storeCode: string,
  requestConfig?: FetchWithRetryConfig
): Promise<string[]> {
  const known = sourceCodesByStore.get(storeCode);
  if (known) return known;

  const { response } = await fetchWithRetryDetailed(
    apiUrl,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", store: storeCode },
      body: JSON.stringify({ query: "{ InventorySources { source_code } }" }),
    },
    requestConfig
  );
  const parsed = z
    .object({ data: z.object({ InventorySources: z.array(z.object({ source_code: z.string() })) }) })
    .safeParse(response?.ok ? await response.json().catch(() => null) : null);
  if (!parsed.success) {
    console.error("[MERCA] branches could not be read: prices only this time");
    return [];
  }

  // Codes go into the query text: only plain ones.
  const codes = parsed.data.data.InventorySources.map((source) => source.source_code).filter((code) =>
    /^[A-Za-z0-9_-]+$/.test(code)
  );
  sourceCodesByStore.set(storeCode, codes);
  return codes;
}

/** The branches past the first request's, in one more request; null if it fails. */
async function fetchRemainingSourceItems(
  apiUrl: string,
  storeCode: string,
  skus: string[],
  codes: string[],
  requestConfig?: FetchWithRetryConfig
): Promise<SourceItem[] | null> {
  await randomDelay(1000, 1500);
  const { response } = await fetchWithRetryDetailed(
    apiUrl,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", store: storeCode },
      body: JSON.stringify({
        query: `query MercaJumboSourceItems($skus: [String!]!, $pageSize: Int!) {\n  ${sourceItemsFields(codes)}\n}`,
        variables: { skus, pageSize: skus.length },
      }),
    },
    requestConfig
  );
  const parsed = z
    .object({ data: z.record(z.unknown()) })
    .safeParse(response?.ok ? await response.json().catch(() => null) : null);
  return parsed.success ? readSourceItems(parsed.data.data, codes) : null;
}

const mercaJumboProductItemSchema = z
  .object({
    sku: z.string(),
    name: z.string().nullable().optional(),
    url_key: z.string().nullable().optional(),
    image: z
      .object({
        url: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    small_image: z
      .object({
        url: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    stock_status: magentoStockStatusSchema,
    price_range: z
      .object({
        minimum_price: z.object({
          final_price: z.object({
            value: z.number().nullable().optional(),
          }),
          regular_price: z.object({
            value: z.number().nullable().optional(),
          }),
        }),
      })
      .nullable()
      .optional(),
  })
  .merge(magentoPurchaseTermsGraphqlSchema);

type MercaJumboProductItem = z.infer<typeof mercaJumboProductItemSchema>;

const mercaJumboProductResponseSchema = z.object({
  data: z.object({
    products: z.object({
      items: z.array(mercaJumboProductItemSchema).default([]),
    }),
  }),
});

export type MercaJumboProduct = {
  outOfStockOnline: boolean | null;
  /** Each branch that carries it (batch only); undefined when the branches could not be read. */
  locations?: ScrapeLocationAvailability[];
  sku: string;
  name: string | null;
  urlKey: string | null;
  imageUrls: string[];
  finalPrice: string | null;
  regularPrice: string | null;
  purchaseTermsFields: MagentoGraphqlPurchaseFields;
};

export type MercaJumboProductLookupResult =
  | {
      status: "ok";
      product: MercaJumboProduct;
    }
  | {
      status: "error";
      reason:
        | "invalid_url"
        | "missing_api"
        | "missing_store_code"
        | "request_failed"
        | "timeout"
        | "dns_failed"
        | "network_error"
        | "request_aborted"
        | "tls_error"
        | "invalid_payload"
        | `http_${number}`;
      retryable: boolean;
    }
  | {
      status: "not_found";
      reason: "product_not_found";
    };

function normalizeEnvValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

// api may hold the GraphQL endpoint, nothing, or (rows added on 2026-11-01)
// the SKU itself; only an http(s) URL overrides the configured endpoint.
export function resolveMercaJumboApiUrl(api: string | null | undefined) {
  const value = normalizeEnvValue(api ?? undefined);
  return (value && /^https?:\/\//i.test(value) ? value : null) ??
    normalizeEnvValue(process.env[MERCA_JUMBO_API_URL_ENV]);
}

export function resolveMercaJumboStoreCode() {
  return normalizeEnvValue(process.env[MERCA_JUMBO_STORE_CODE_ENV]);
}

export function extractMercaJumboSkuFromUrl(url: string) {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return "";
  }

  try {
    const pathname = new URL(normalizedUrl).pathname.replace(/\/+$/, "");
    const lastSegment = pathname.split("/").pop() ?? "";
    const match = lastSegment.match(/(\d+)$/);
    return match?.[1] ?? "";
  } catch {
    const match = normalizedUrl.replace(/[?#].*$/, "").match(/(\d+)(?:\/)?$/);
    return match?.[1] ?? "";
  }
}

function toPriceString(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value)
    ? null
    : String(value);
}

export async function fetchMercaJumboProductBySku(
  input: {
    sku: string;
    api: string | null | undefined;
  },
  requestConfig?: FetchWithRetryConfig
): Promise<MercaJumboProductLookupResult> {
  if (!input.sku.trim()) {
    return {
      status: "error",
      reason: "invalid_url",
      retryable: false,
    };
  }

  const apiUrl = resolveMercaJumboApiUrl(input.api);
  if (!apiUrl) {
    return {
      status: "error",
      reason: "missing_api",
      retryable: false,
    };
  }

  const storeCode = resolveMercaJumboStoreCode();
  if (!storeCode) {
    return {
      status: "error",
      reason: "missing_store_code",
      retryable: false,
    };
  }

  const { response, failureReason } = await fetchWithRetryDetailed(
    apiUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        store: storeCode,
      },
      body: JSON.stringify({
        query: mercaJumboProductQuery,
        variables: {
          sku: input.sku,
        },
      }),
    },
    requestConfig
  );

  if (!response) {
    return {
      status: "error",
      reason: failureReason ?? "request_failed",
      retryable: true,
    };
  }

  if (!response.ok) {
    return {
      status: "error",
      reason: `http_${response.status}`,
      retryable: response.status >= 500 || response.status === 429,
    };
  }

  const parsedResponse = mercaJumboProductResponseSchema.safeParse(
    await response.json().catch(() => null)
  );

  if (!parsedResponse.success) {
    return {
      status: "error",
      reason: "invalid_payload",
      retryable: false,
    };
  }

  const product =
    parsedResponse.data.data.products.items.find(
      (candidate) => candidate.sku === input.sku
    ) ?? null;

  if (!product) {
    return {
      status: "not_found",
      reason: "product_not_found",
    };
  }

  return {
    status: "ok",
    product: toMercaJumboProduct(product),
  };
}

function toMercaJumboProduct(product: MercaJumboProductItem): MercaJumboProduct {
  return {
    sku: product.sku,
    name: product.name ?? null,
    urlKey: product.url_key ?? null,
    imageUrls: dedupeComparableUrls([
      product.image?.url,
      product.small_image?.url,
    ]).map(normalizeNacionalImageUrl),
    finalPrice: toPriceString(
      product.price_range?.minimum_price.final_price.value ?? null
    ),
    regularPrice: toPriceString(
      product.price_range?.minimum_price.regular_price.value ?? null
    ),
    purchaseTermsFields: product,
    outOfStockOnline: magentoOutOfStockOnline(product.stock_status),
  };
}

export async function fetchMercaJumboProductsBySkus(
  input: {
    skus: string[];
    api: string | null | undefined;
  },
  requestConfig?: FetchWithRetryConfig
): Promise<MagentoGraphqlBatchLookup<MercaJumboProduct>> {
  const apiUrl = resolveMercaJumboApiUrl(input.api);
  if (!apiUrl) {
    return { ok: false, reason: "missing_api" };
  }

  const storeCode = resolveMercaJumboStoreCode();
  if (!storeCode) {
    return { ok: false, reason: "missing_store_code" };
  }

  const sourceCodes = await mercaJumboSourceCodes(apiUrl, storeCode, requestConfig);
  const firstCodes = sourceCodes.slice(0, SOURCES_PER_REQUEST);
  const restCodes = sourceCodes.slice(SOURCES_PER_REQUEST);
  const lookup = await fetchMagentoGraphqlItemsBySku(
    {
      url: apiUrl,
      storeCode,
      query: mercaJumboProductsBySkuQuery(firstCodes),
      skus: input.skus,
      itemSchema: mercaJumboProductItemSchema,
    },
    requestConfig
  );
  if (!lookup.ok) {
    return lookup;
  }

  // Prices stand on their own: if a branch field fails, this batch just
  // carries no branches and the stored ones stay.
  let sourceItems = sourceCodes.length > 0 ? readSourceItems(lookup.data, firstCodes) : null;
  if (sourceItems && restCodes.length > 0) {
    const rest = await fetchRemainingSourceItems(apiUrl, storeCode, input.skus, restCodes, requestConfig);
    sourceItems = rest ? [...sourceItems, ...rest] : null;
  }

  return {
    ...lookup,
    items: new Map(
      [...lookup.items].map(([sku, item]) => [
        sku,
        item === null
          ? null
          : {
              ...toMercaJumboProduct(item),
              ...(sourceItems ? { locations: mercaJumboLocations(sourceItems, sku) } : {}),
            },
      ])
    ),
  };
}

function mercaJumboLocations(sourceItems: SourceItem[], sku: string): ScrapeLocationAvailability[] {
  return sourceItems
    .filter((item) => item.sku === sku)
    .map((item) => ({
      externalId: item.code,
      available: item.status === 1,
      stock: item.quantity,
      currentPrice: null,
      regularPrice: null,
    }));
}
