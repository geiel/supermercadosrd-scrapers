import { z } from "zod";
import { PLAZA_LAMA_GRAPHQL_URL } from "../api-endpoints.js";
import { fetchWithRetry, getPlazaLamaHeaders } from "../http-client.js";
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

const shopId = 4;
const PLAZA_LAMA_SKU_PATTERN = /-([0-9]{8,14})\/?$/i;

const query = `query GetProductsBySKU($getProductsBySKUInput: GetProductsBySKUInput!) {
  getProductsBySKU(getProductsBySKUInput: $getProductsBySKUInput) {
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

const responseSchema = z.array(
  z.object({
    data: z.object({
      getProductsBySKU: z.array(
        z.object({
          price: z.number(),
          unit: z.string().nullable().optional(),
          subUnit: z.string().nullable().optional(),
          subQty: z.number().nullable().optional(),
          minQty: z.number().nullable().optional(),
          maxQty: z.number().nullable().optional(),
          clickMultiplier: z.number().nullable().optional(),
          isActive: z.boolean().optional(),
          isAvailable: z.boolean().optional(),
          promotion: z
            .object({
              isActive: z.boolean().optional(),
              conditions: z.array(
                z.object({
                  price: z.number(),
                })
              ),
            })
            .nullable(),
        })
      ),
    }),
  })
);

function extractPlazaLamaSku(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    return pathname.match(PLAZA_LAMA_SKU_PATTERN)?.[1] ?? null;
  } catch {
    return url.match(PLAZA_LAMA_SKU_PATTERN)?.[1] ?? null;
  }
}

function getPlazaLamaSku(input: ScrapePriceInput): string | null {
  return input.api?.trim() || extractPlazaLamaSku(input.url);
}

export function resolvePlazaLamaPurchaseUnit(input: {
  subUnit?: string | null;
  unit?: string | null;
  baseUnit?: string | null;
  productUnit?: string | null;
}) {
  const rawUnit = [
    input.subUnit,
    input.unit,
    input.baseUnit,
    input.productUnit,
  ].find((value) => typeof value === "string" && value.trim().length > 0);

  return normalizePurchaseUnit(rawUnit);
}

export async function scrapePlazaLamaPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const sku = getPlazaLamaSku(input);
  if (!sku) {
    return error(shopId, "missing_api", false, false);
  }

  const payload = [
    {
      operationName: "GetProductsBySKU",
      variables: {
        getProductsBySKUInput: {
          clientId: "PLAZA_LAMA",
          skus: [sku],
          storeReference: "PL08-D",
        },
      },
      query,
    },
  ];

  const response = await fetchWithRetry(
    PLAZA_LAMA_GRAPHQL_URL,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: getPlazaLamaHeaders(),
    },
    requestConfig
  );

  if (!response) {
    return error(shopId, "request_failed", true, false);
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  if (!jsonResponse) {
    return error(shopId, "invalid_json", true, false);
  }

  const parsed = responseSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, false);
  }

  const products = parsed.data[0]?.data.getProductsBySKU ?? [];
  if (products.length === 0) {
    return notFound(shopId, "product_not_found", true);
  }

  const first = products[0];
  if (first.isActive === false || first.isAvailable === false) {
    return notFound(shopId, "product_not_available", true);
  }

  const promoPrice =
    first.promotion?.isActive !== false
      ? first.promotion?.conditions[0]?.price
      : undefined;
  const currentPrice = promoPrice ?? first.price;
  const increment =
    typeof first.clickMultiplier === "number" && first.clickMultiplier > 0
      ? first.clickMultiplier
      : typeof first.subQty === "number" && first.subQty > 0
        ? first.subQty
        : 1;
  const minimum =
    typeof first.minQty === "number" && first.minQty > 0
      ? first.minQty
      : increment;
  const unit = resolvePlazaLamaPurchaseUnit({
    subUnit: first.subUnit,
    unit: first.unit,
    baseUnit: input.baseUnit,
    productUnit: input.unit,
  });
  const hasExactPurchaseFields = [
    first.subQty,
    first.minQty,
    first.maxQty,
    first.clickMultiplier,
  ].some((value) => typeof value === "number" && Number.isFinite(value));
  const purchaseTerms = hasExactPurchaseFields
    ? buildPurchaseTerms({
        mode: inferModeFromUnit(unit),
        unit,
        minimum,
        increment,
        maximum: first.maxQty,
        priceReferenceQuantity: 1,
        source: "plaza_lama_instaleap",
        evidence: {
          unit: first.unit,
          subUnit: first.subUnit,
          subQty: first.subQty,
          minQty: first.minQty,
          maxQty: first.maxQty,
          clickMultiplier: first.clickMultiplier,
        },
      })
    : undefined;

  return ok(
    shopId,
    String(currentPrice),
    String(first.price),
    null,
    undefined,
    undefined,
    purchaseTerms
  );
}
