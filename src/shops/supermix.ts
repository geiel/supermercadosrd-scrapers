import { z } from "zod";
import { buildPurchaseTerms, type PurchaseTerms } from "../purchase-terms.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

// Supermix moved from Shopify to a Vendabo storefront on 2026-10-07. Prices
// come from its public JSON API: the catalog listing returns 100 products per
// page, so a full refresh pages through the catalog instead of asking for each
// product. This module intentionally avoids ../http-client.js: that file loads
// every other shop's endpoint secrets, and Supermix must not depend on them.

export const SUPERMIX_SHOP_ID = 14;
export const SUPERMIX_ORIGIN = "https://supermix.com.do";
export const SUPERMIX_CATALOG_PAGE_SIZE = 100;

const shopId = SUPERMIX_SHOP_ID;
const USER_AGENT =
  "Mozilla/5.0 (compatible; SupermercadosRD-PriceSync/1.0; +https://supermercadosrd.com)";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 10000;

export type SupermixApiConfig = {
  apiBaseUrl: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export function getSupermixApiConfig(): SupermixApiConfig {
  return { apiBaseUrl: `${SUPERMIX_ORIGIN}/api/storefront/v1` };
}

/**
 * `api` holds the Supermix (Vendabo) product id, or `<productId>:<variantId>`
 * when the product groups several variants (sizes, colors) with their own prices.
 */
export function parseSupermixReference(api: string | null | undefined) {
  const match = api?.trim().match(/^(\d+)(?::(\d+))?$/);
  return match ? { productId: match[1], variantId: match[2] ?? null } : null;
}

function parseSupermixPath(url: string | null | undefined) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    return /(^|\.)supermix\.com\.do$/i.test(parsed.hostname) ? parsed.pathname : null;
  } catch {
    return null;
  }
}

/** Product slug from a `/p/<slug>` URL. */
export function parseSupermixSlug(url: string | null | undefined) {
  const match = parseSupermixPath(url)?.match(/^\/p\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}

/**
 * Shopify-era `/products/<handle>` links. Many handles now belong to a renamed
 * or different product, so they are never matched by slug: the 2026-10 migration
 * gave every verified link a product id and a `/p/` URL.
 */
export function isLegacySupermixUrl(url: string | null | undefined) {
  return /^\/products\/[^/]+\/?$/.test(parseSupermixPath(url) ?? "");
}

export function buildSupermixProductUrl(slug: string) {
  return `${SUPERMIX_ORIGIN}/p/${encodeURIComponent(slug)}`;
}

const moneySchema = z.object({ amount: z.string() });
const productSchema = z.object({
  id: z.number(),
  slug: z.string(),
  in_stock: z.boolean(),
  pricing: z.object({
    price: moneySchema.nullable(),
    original_price: moneySchema.nullable(),
    price_from: z.boolean(),
  }),
});

const variantSchema = z.object({
  id: z.number(),
  in_stock: z.boolean(),
  pricing: z.object({
    price: moneySchema.nullable(),
    original_price: moneySchema.nullable(),
  }),
});
const productWithVariantsSchema = z.object({
  slug: z.string(),
  variants: z.array(variantSchema),
});

function toPositivePrice(amount: string | null | undefined) {
  const value = Number(amount);
  return amount && Number.isFinite(value) && value > 0 ? value.toFixed(2) : null;
}

/**
 * Price of a listing or detail product. With `variantId` the product must be a
 * detail payload, and the price is that variant's own price.
 */
export function toSupermixPriceResult(
  product: unknown,
  variantId: string | null = null
): ScrapePriceResult {
  if (product === null || product === undefined) {
    return notFound(shopId, "product_not_found", true);
  }

  if (variantId !== null) {
    const parsed = productWithVariantsSchema.safeParse(product);
    if (!parsed.success) {
      return error(shopId, "invalid_payload", false, false);
    }

    const variant = parsed.data.variants.find((item) => String(item.id) === variantId);
    if (!variant) {
      return notFound(shopId, "variant_not_found", true);
    }

    return toPrice(parsed.data.slug, variant.in_stock, variant.pricing);
  }

  const parsed = productSchema.safeParse(product);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, false);
  }

  // "Desde RD$..." prices depend on a variant; such links must name it in `api`.
  if (parsed.data.pricing.price_from) {
    return error(shopId, "multiple_variants", false, true);
  }

  return toPrice(parsed.data.slug, parsed.data.in_stock, parsed.data.pricing);
}

function toPrice(
  slug: string,
  inStock: boolean,
  pricing: { price: { amount: string } | null; original_price: { amount: string } | null }
): ScrapePriceResult {
  if (!inStock) {
    return notFound(shopId, "unavailable", true);
  }

  const currentPrice = toPositivePrice(pricing.price?.amount);
  if (!currentPrice) {
    return notFound(shopId, "price_not_found", true);
  }

  const originalPrice = toPositivePrice(pricing.original_price?.amount);
  const regularPrice =
    originalPrice && Number(originalPrice) > Number(currentPrice)
      ? originalPrice
      : null;

  return ok(shopId, currentPrice, regularPrice, null, buildSupermixProductUrl(slug));
}

export const SUPERMIX_PURCHASE_TERMS_SOURCE = "supermix_vendabo_product";

const listingTermsSchema = z.object({
  quick_add_variant_id: z.number().nullable(),
  pricing: z.object({ price_from: z.boolean() }),
});

/**
 * Whether a listing product may be sold by weight. Weighed products cannot be
 * quick-added (the shopper must pick a weight), so the listing leaves
 * `quick_add_variant_id` empty for them; products with a fixed price per unit
 * carry one. The listing has no weight fields, so only these candidates need
 * the detail payload to learn their purchase terms.
 */
export function isSupermixWeightCandidate(listingProduct: unknown) {
  const parsed = listingTermsSchema.safeParse(listingProduct);
  return parsed.success && parsed.data.quick_add_variant_id === null && !parsed.data.pricing.price_from;
}

const detailTermsSchema = z.object({
  id: z.number(),
  title: z.string(),
  supermarket: z.object({ weight_unit: z.string().nullable().optional() }).nullable().optional(),
  variants: z.array(
    z.object({
      id: z.number(),
      sku: z.string().nullable().optional(),
      pricing: z.object({ price: moneySchema.nullable() }),
      supermarket: z
        .object({
          variable_weight: z.boolean(),
          price_per_unit: moneySchema.nullable().optional(),
          minimum_weight: z.number().nullable().optional(),
          weight_step: z.number().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
  ),
});

function toAmount(value: string | null | undefined) {
  const amount = Number(value);
  return value && Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Purchase terms from a product detail payload, for the price that will be
 * saved with them (`shownPrice`). A variable-weight variant is priced per pound
 * (or kilogram) with the store's minimum and step; deli items have no fixed
 * step, so their minimum is used as the step. A variant with no weight data is
 * sold per unit. Returns undefined when the payload is unclear.
 */
export function extractSupermixPurchaseTerms(
  product: unknown,
  shownPrice: string,
  variantId: string | null = null
): PurchaseTerms | undefined {
  const parsed = detailTermsSchema.safeParse(product);
  if (!parsed.success) {
    return undefined;
  }

  const { variants } = parsed.data;
  const variant =
    variantId === null
      ? variants.length === 1
        ? variants[0]
        : undefined
      : variants.find((item) => String(item.id) === variantId);
  if (!variant) {
    return undefined;
  }

  const evidence = {
    productId: parsed.data.id,
    variantId: variant.id,
    sku: variant.sku ?? null,
    title: parsed.data.title,
  };

  const weight = variant.supermarket;
  const productWeight = parsed.data.supermarket;
  const unit = productWeight?.weight_unit?.trim().toLowerCase() || null;
  // Unit products send `supermarket: null` on both the product (or a null
  // weight unit) and the variant. Omitted fields, or a weight unit without the
  // variant's flag, are an incomplete payload and give no terms.
  const soldPerUnit = weight
    ? weight.variable_weight === false
    : weight === null && (productWeight === null || productWeight?.weight_unit === null);
  if (soldPerUnit) {
    return buildPurchaseTerms({
      mode: "unit",
      unit: "UND",
      minimum: 1,
      increment: 1,
      source: SUPERMIX_PURCHASE_TERMS_SOURCE,
      evidence: { ...evidence, variableWeight: false },
    });
  }

  if (!weight?.variable_weight || (unit !== "lb" && unit !== "kg")) {
    return undefined;
  }

  // The saved price and the variant's price must both be the per-weight
  // price, or the reference is unclear.
  const pricePerUnit = weight.price_per_unit?.amount;
  const perUnit = toAmount(pricePerUnit);
  const prices = [toAmount(shownPrice), toAmount(variant.pricing.price?.amount)];
  if (!perUnit || prices.some((price) => !price || Math.abs(price - perUnit) > 0.005)) {
    return undefined;
  }

  const minimum = weight.minimum_weight ?? 0;
  const step = weight.weight_step ?? 0;
  return buildPurchaseTerms({
    mode: "measure",
    unit: unit.toUpperCase(),
    minimum,
    increment: step > 0 ? step : minimum,
    priceReferenceQuantity: 1,
    source: SUPERMIX_PURCHASE_TERMS_SOURCE,
    evidence: {
      ...evidence,
      variableWeight: true,
      pricePerUnit,
      minimumWeight: weight.minimum_weight ?? null,
      weightStep: weight.weight_step ?? null,
      weightUnit: unit,
    },
  });
}

type ApiResponse =
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: string };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** GET with retries on network errors, 429 and 5xx. 404 is returned as a status, not a failure. */
async function getJson(url: string, config: SupermixApiConfig): Promise<ApiResponse> {
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastReason = "request_failed";
  let nextDelayMs = retryDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(nextDelayMs);
      nextDelayMs = retryDelayMs * 3 ** (attempt - 1);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (fetchError) {
      lastReason =
        fetchError instanceof Error && fetchError.name === "TimeoutError"
          ? "timeout"
          : "network_error";
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      lastReason = `http_${response.status}`;
      const waitMs = retryAfterMs(response);
      if (waitMs) {
        nextDelayMs = Math.min(waitMs, 60000);
      }
      continue;
    }

    if (response.status === 404) {
      return { ok: true, status: 404, body: null };
    }

    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }

    const body = await response.json().catch(() => undefined);
    if (body === undefined) {
      return { ok: false, reason: "invalid_json" };
    }

    return { ok: true, status: response.status, body };
  }

  return { ok: false, reason: lastReason };
}

/** One catalog page, oldest products first so pages stay stable while the job runs. */
export async function fetchSupermixCatalogPage(
  page: number,
  config: SupermixApiConfig
): Promise<{ ok: true; products: unknown[] } | { ok: false; reason: string }> {
  const params = new URLSearchParams({
    per_page: String(SUPERMIX_CATALOG_PAGE_SIZE),
    sort: "created_at:asc",
    page: String(page),
  });
  const response = await getJson(`${config.apiBaseUrl}/products?${params}`, config);
  if (!response.ok) {
    return response;
  }

  const products = (response.body as { products?: unknown } | null)?.products;
  if (response.status !== 200 || !Array.isArray(products)) {
    return { ok: false, reason: "invalid_catalog_payload" };
  }

  return { ok: true, products };
}

/** Product detail by id or slug; `product` is null when Supermix no longer has it. */
export async function fetchSupermixProduct(
  idOrSlug: string,
  config: SupermixApiConfig
): Promise<{ ok: true; product: unknown | null } | { ok: false; reason: string }> {
  const response = await getJson(
    `${config.apiBaseUrl}/products/${encodeURIComponent(idOrSlug)}`,
    config
  );
  if (!response.ok) {
    return response;
  }

  return { ok: true, product: response.status === 404 ? null : response.body };
}

/** Single-product lookup; the scheduled job pages through the catalog instead. */
export async function scrapeSupermixPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const parsedReference = parseSupermixReference(input.api);
  const reference = parsedReference?.productId ?? parseSupermixSlug(input.url);
  if (!reference) {
    return isLegacySupermixUrl(input.url)
      ? notFound(shopId, "legacy_shopify_link", true)
      : error(shopId, "missing_product_reference", false, false);
  }

  const fetched = await fetchSupermixProduct(reference, {
    ...getSupermixApiConfig(),
    timeoutMs: requestConfig?.timeoutMs,
    maxAttempts: requestConfig?.maxRetries,
  });
  if (!fetched.ok) {
    return error(shopId, fetched.reason, true, false);
  }

  return toSupermixPriceResult(fetched.product, parsedReference?.variantId ?? null);
}
