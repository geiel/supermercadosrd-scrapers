import { z } from "zod";
import { fetchWithRetry, getSirenaHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import {
  buildPurchaseTerms,
  inferModeFromUnit,
  normalizePurchaseUnit,
} from "../purchase-terms.js";
import {
  normalizeSirenaVtexProduct,
  parseSirenaVtexProductsPayload,
  withSirenaVtexSalesChannel,
} from "../sirena-vtex.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 1;

const productSchema = z
  .object({
    product: z.object({
      thumbs: z.string(),
      category: z.string(),
      price: z.string(),
      regular_price: z.string(),
      minimum: z.unknown().optional(),
      producttype_step: z.unknown().optional(),
      producttype_decimal: z.unknown().optional(),
    }),
  })
  .or(
    z.object({
      message: z.string(),
    })
  );

function isPositivePriceString(value: string | null | undefined) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0;
}

export async function scrapeSirenaPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  if (!input.api && !input.url) {
    return error(shopId, "missing_api", false, false);
  }

  const response = await fetchWithRetry(
    withSirenaVtexSalesChannel(input.api ?? input.url),
    { headers: getSirenaHeaders() },
    requestConfig
  );

  if (!response) {
    return error(shopId, "request_failed", true, false);
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  if (!jsonResponse) {
    return error(shopId, "invalid_json", true, false);
  }

  const vtexProducts = parseSirenaVtexProductsPayload(jsonResponse);
  if (vtexProducts?.[0]) {
    const normalizedProduct = normalizeSirenaVtexProduct(vtexProducts[0]);

    if (!normalizedProduct.currentPrice) {
      return notFound(shopId, "vtex_price_not_found", true);
    }

    return ok(
      shopId,
      normalizedProduct.currentPrice,
      normalizedProduct.regularPrice
    );
  }

  const parsed = productSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, true);
  }

  if ("message" in parsed.data) {
    return notFound(shopId, parsed.data.message, true);
  }

  const currentPrice = parsed.data.product.price;
  if (!isPositivePriceString(currentPrice)) {
    return notFound(shopId, "price_not_found", true);
  }

  const regularPrice = parsed.data.product.regular_price;
  const product = parsed.data.product;
  const unit = normalizePurchaseUnit(input.baseUnit ?? input.unit);
  const supportsDecimals =
    product.producttype_decimal === true ||
    product.producttype_decimal === 1 ||
    String(product.producttype_decimal).toLowerCase() === "true";
  const purchaseTerms = buildPurchaseTerms({
    mode: supportsDecimals ? "measure" : inferModeFromUnit(unit),
    unit,
    minimum: product.minimum,
    increment: product.producttype_step,
    priceReferenceQuantity: 1,
    source: "sirena_legacy_api",
    evidence: {
      minimum: product.minimum,
      producttype_step: product.producttype_step,
      producttype_decimal: product.producttype_decimal,
    },
  });

  return ok(
    shopId,
    currentPrice,
    isPositivePriceString(regularPrice) ? regularPrice : currentPrice,
    null,
    undefined,
    undefined,
    purchaseTerms
  );
}
