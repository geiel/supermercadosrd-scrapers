import { z } from "zod";
import { PLAZA_LAMA_GRAPHQL_URL } from "../api-endpoints.js";
import {
  GARRIDO_STORE_REFERENCES,
  GARRIDO_DEFAULT_STORE_REFERENCE,
} from "../garrido-locations.js";
import { fetchWithRetry, getGarridoHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import {
  buildPurchaseTerms,
  inferModeFromUnit,
  normalizePurchaseUnit,
} from "../purchase-terms.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 8;
const GARRIDO_URL_SKU_PATTERN = /\/p\/([^/?#]+)/i;

const query = `query GetProductsBySKU($getProductsBySKUInput: GetProductsBySKUInput!) {
  getProductsBySKU(getProductsBySKUInput: $getProductsBySKUInput) {
    sku
    price
    unit
    subUnit
    subQty
    minQty
    maxQty
    clickMultiplier
    isActive
    isAvailable
    promotion {
      isActive
      conditions {
        price
      }
    }
  }
}`;

const productSchema = z.object({
  sku: z.string(),
  price: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  subUnit: z.string().nullable().optional(),
  subQty: z.number().nullable().optional(),
  minQty: z.number().nullable().optional(),
  maxQty: z.number().nullable().optional(),
  clickMultiplier: z.number().nullable().optional(),
  isActive: z.boolean().nullable().optional(),
  isAvailable: z.boolean().nullable().optional(),
  promotion: z
    .object({
      isActive: z.boolean().nullable().optional(),
      conditions: z
        .array(
          z.object({
            price: z.number().nullable().optional(),
          })
        )
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const responseSchema = z.array(
  z.object({
    data: z.object({
      getProductsBySKU: z.array(productSchema).default([]),
    }),
  })
);

type GarridoProduct = z.infer<typeof productSchema>;

function extractGarridoSkuFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    return pathname.match(GARRIDO_URL_SKU_PATTERN)?.[1] ?? null;
  } catch {
    return url.match(GARRIDO_URL_SKU_PATTERN)?.[1] ?? null;
  }
}

function getGarridoSkuCandidates(input: ScrapePriceInput) {
  const skuCandidates: string[] = [];

  if (input.api?.trim()) {
    skuCandidates.push(input.api.trim());
  }

  const urlSku = extractGarridoSkuFromUrl(input.url);
  if (urlSku && !skuCandidates.includes(urlSku)) {
    skuCandidates.push(urlSku);
  }

  return skuCandidates;
}

async function fetchGarridoProduct(
  sku: string,
  storeReference: string,
  requestConfig?: FetchWithRetryConfig
) {
  const response = await fetchWithRetry(
    PLAZA_LAMA_GRAPHQL_URL,
    {
      method: "POST",
      body: JSON.stringify([
        {
          operationName: "GetProductsBySKU",
          variables: {
            getProductsBySKUInput: {
              clientId: "TIENDAS_GARRIDO",
              skus: [sku],
              storeReference,
            },
          },
          query,
        },
      ]),
      headers: getGarridoHeaders(),
    },
    requestConfig
  );

  if (!response) {
    return undefined;
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  if (!jsonResponse) {
    return undefined;
  }

  const parsed = responseSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    return undefined;
  }

  return parsed.data[0]?.data.getProductsBySKU[0] ?? null;
}

function getActivePrice(product: GarridoProduct) {
  const promotionPrice =
    product.promotion?.isActive !== false
      ? product.promotion?.conditions?.[0]?.price
      : undefined;

  return typeof promotionPrice === "number" ? promotionPrice : product.price;
}

function getPriceMultiplier(product: GarridoProduct) {
  const clickMultiplier = product.clickMultiplier;

  if (
    typeof clickMultiplier !== "number" ||
    !Number.isFinite(clickMultiplier) ||
    clickMultiplier <= 1
  ) {
    return 1;
  }

  return clickMultiplier;
}

function toGarridoPriceString(price: number, product: GarridoProduct) {
  const displayPrice = price * getPriceMultiplier(product);
  const roundedPrice = Math.round((displayPrice + Number.EPSILON) * 100) / 100;

  return String(roundedPrice);
}

export async function scrapeGarridoPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const skuCandidates = getGarridoSkuCandidates(input);
  if (skuCandidates.length === 0) {
    return error(shopId, "missing_api", false, false);
  }

  for (const sku of skuCandidates) {
    for (const storeReference of GARRIDO_STORE_REFERENCES) {
      const product = await fetchGarridoProduct(sku, storeReference, requestConfig);

      if (product === undefined) {
        return error(shopId, "request_failed", true, false);
      }

      if (product === null) {
        continue;
      }

      if (product.isActive === false || product.isAvailable === false) {
        continue;
      }

      const currentPrice = getActivePrice(product);
      if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice)) {
        return error(shopId, "price_not_found", false, false);
      }

      const regularPrice =
        typeof product.price === "number" && product.price !== currentPrice
          ? toGarridoPriceString(product.price, product)
          : null;
      const canonicalUrl = `https://www.garrido.com.do/p/${encodeURIComponent(
        product.sku || sku
      )}`;
      const multiplier = getPriceMultiplier(product);
      const unit = normalizePurchaseUnit(
        product.subUnit ?? product.unit ?? input.baseUnit ?? input.unit
      );
      const minimum =
        typeof product.minQty === "number" && product.minQty > 0
          ? product.minQty
          : multiplier;
      const hasExactPurchaseFields = [
        product.subQty,
        product.minQty,
        product.maxQty,
        product.clickMultiplier,
      ].some((value) => typeof value === "number" && Number.isFinite(value));
      const purchaseTerms = hasExactPurchaseFields
        ? buildPurchaseTerms({
            mode: inferModeFromUnit(unit),
            unit,
            minimum,
            increment: multiplier,
            maximum: product.maxQty,
            priceReferenceQuantity: multiplier,
            source: "garrido_instaleap",
            evidence: {
              unit: product.unit,
              subUnit: product.subUnit,
              subQty: product.subQty,
              minQty: product.minQty,
              maxQty: product.maxQty,
              clickMultiplier: product.clickMultiplier,
            },
          })
        : undefined;

      return ok(
        shopId,
        toGarridoPriceString(currentPrice, product),
        regularPrice,
        storeReference || GARRIDO_DEFAULT_STORE_REFERENCE,
        canonicalUrl,
        undefined,
        purchaseTerms
      );
    }
  }

  return notFound(shopId, "product_not_found", true);
}
