import { z } from "zod";
import { fetchWithRetry, getCarrefourHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 10;
const CARREFOUR_TYPESENSE_BASE_URL = "https://typesense.quickkart.app";
const CARREFOUR_DEFAULT_PLAZA_DUARTE_COLLECTION_ID =
  process.env.CARREFOUR_PLAZA_DUARTE_COLLECTION_ID?.trim() ?? "";
const CARREFOUR_PLAZA_DUARTE_LOCATION_ID = "plaza_duarte";

const carrefourProductSchema = z
  .object({
    internalCode: z.union([z.string(), z.number()]),
    salePrice: z.unknown().optional(),
    offerPrice: z.unknown().optional(),
    maxPurchase: z.unknown().optional(),
  })
  .passthrough();

const carrefourSearchResponseSchema = z
  .object({
    hits: z
      .array(
        z.object({
          document: carrefourProductSchema.nullable().optional(),
        })
      )
      .optional()
      .default([]),
  })
  .passthrough();

type CarrefourProduct = z.infer<typeof carrefourProductSchema>;

function normalizeString(value: unknown) {
  return String(value ?? "").trim();
}

function normalizePrice(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return String(parsed);
}

function getPositivePrice(value: unknown) {
  const price = normalizePrice(value);
  return price && Number(price) > 0 ? price : null;
}

function buildCarrefourCanonicalUrl(sku: string) {
  return `https://www.carrefour.do/?s=${encodeURIComponent(sku)}`;
}

function getSkuFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const searchSku = parsed.searchParams.get("s")?.trim();

    if (searchSku) {
      return searchSku;
    }

    return parsed.pathname.match(/\/([0-9]{4,})\/?$/)?.[1] ?? null;
  } catch {
    return url.match(/[?&]s=([^&#]+)/)?.[1] ?? null;
  }
}

function getCarrefourSku(input: ScrapePriceInput) {
  return input.api?.trim() || getSkuFromUrl(input.url);
}

function getCollectionId(input: ScrapePriceInput) {
  const locationId = input.locationId?.trim();

  if (!locationId || locationId === CARREFOUR_PLAZA_DUARTE_LOCATION_ID) {
    return CARREFOUR_DEFAULT_PLAZA_DUARTE_COLLECTION_ID;
  }

  return locationId;
}

async function fetchCarrefourProductBySku(
  input: {
    sku: string;
    collectionId: string;
  },
  requestConfig?: FetchWithRetryConfig
) {
  const params = new URLSearchParams({
    q: "*",
    query_by: "itemName",
    filter_by: `internalCode:=${input.sku}`,
    limit: "1",
    highlight_fields: "none",
  });
  const response = await fetchWithRetry(
    `${CARREFOUR_TYPESENSE_BASE_URL}/collections/${input.collectionId}/documents/search?${params.toString()}`,
    {
      headers: getCarrefourHeaders(),
    },
    requestConfig
  );

  if (!response) {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  if (!jsonResponse) {
    return undefined;
  }

  const parsed = carrefourSearchResponseSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    return undefined;
  }

  return parsed.data.hits[0]?.document ?? null;
}

function getCurrentPrice(product: CarrefourProduct) {
  const salePrice = normalizePrice(product.salePrice);
  const offerPrice = getPositivePrice(product.offerPrice);

  return offerPrice ?? salePrice;
}

function getRegularPrice(product: CarrefourProduct, currentPrice: string) {
  const salePrice = normalizePrice(product.salePrice);

  if (salePrice && Number(salePrice) !== Number(currentPrice)) {
    return salePrice;
  }

  return null;
}

function isAvailable(product: CarrefourProduct) {
  const salePrice = normalizePrice(product.salePrice);
  const maxPurchase = Number(product.maxPurchase);

  return Boolean(
    salePrice &&
      Number(salePrice) > 0 &&
      Number.isFinite(maxPurchase) &&
      maxPurchase > 0
  );
}

export async function scrapeCarrefourPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const sku = getCarrefourSku(input);

  if (!sku) {
    return error(shopId, "missing_sku", false, false);
  }

  const collectionId = getCollectionId(input);
  if (!collectionId) {
    return error(shopId, "missing_collection_id", false, false);
  }

  const product = await fetchCarrefourProductBySku(
    {
      sku,
      collectionId,
    },
    requestConfig
  );

  if (product === undefined) {
    return error(shopId, "request_failed", true, false);
  }

  if (product === null) {
    return notFound(shopId, "product_not_found", true);
  }

  if (!isAvailable(product)) {
    return notFound(shopId, "product_unavailable", true);
  }

  const currentPrice = getCurrentPrice(product);
  if (!currentPrice) {
    return error(shopId, "price_not_found", false, true);
  }

  const canonicalSku = normalizeString(product.internalCode) || sku;

  return ok(
    shopId,
    currentPrice,
    getRegularPrice(product, currentPrice),
    collectionId === CARREFOUR_DEFAULT_PLAZA_DUARTE_COLLECTION_ID
      ? CARREFOUR_PLAZA_DUARTE_LOCATION_ID
      : collectionId,
    buildCarrefourCanonicalUrl(canonicalSku)
  );
}
