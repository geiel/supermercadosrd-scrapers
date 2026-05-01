import { z } from "zod";
import { PLAZA_LAMA_GRAPHQL_URL } from "../api-endpoints.js";
import {
  GARRIDO_STORE_REFERENCES,
  GARRIDO_DEFAULT_STORE_REFERENCE,
} from "../garrido-locations.js";
import { fetchWithRetry, getGarridoHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
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
          ? String(product.price)
          : null;
      const canonicalUrl = `https://www.garrido.com.do/p/${encodeURIComponent(
        product.sku || sku
      )}`;

      return ok(
        shopId,
        String(currentPrice),
        regularPrice,
        storeReference || GARRIDO_DEFAULT_STORE_REFERENCE,
        canonicalUrl
      );
    }
  }

  return notFound(shopId, "product_not_found", true);
}
