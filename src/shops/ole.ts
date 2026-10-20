import { z } from "zod";
import { buildPurchaseTerms, type PurchaseTerms } from "../purchase-terms.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

// Hipermercados Olé sells online through its app "Ole en Casa", a nopCommerce
// 4.50 store with the official Web API Frontend plugin. Olé allowed
// SupermercadosRD to read prices from it (2026-10-19). The catalog endpoints
// answer without a token: the guest token would create a guest customer on
// every run, so it is never requested. A full refresh pages through the root
// categories instead of asking for each product. Like Supermix, this module
// does not use ../http-client.js, which loads every other shop's secrets.

export const OLE_SHOP_ID = 15;
export const OLE_ORIGIN = "https://ecommerce.hiperole.com.do";
// Each category only accepts page sizes from its own list (15/25/50/75 in most,
// 3/6/9 in a few) and falls back to its default for any other value.
export const OLE_PREFERRED_PAGE_SIZE = 75;
export const OLE_PURCHASE_TERMS_SOURCE = "ole_product_details";

const shopId = OLE_SHOP_ID;
const USER_AGENT =
  "Mozilla/5.0 (compatible; SupermercadosRD-PriceSync/1.0; +https://supermercadosrd.com)";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 10000;
const MAX_PAGES_PER_CATEGORY = 500;

export type OleApiConfig = {
  apiBaseUrl: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export function getOleApiConfig(): OleApiConfig {
  return { apiBaseUrl: `${OLE_ORIGIN}/api-frontend` };
}

/** `api` holds the Olé (nopCommerce) product id. */
export function parseOleProductId(api: string | null | undefined) {
  const match = api?.trim().match(/^\d+$/);
  return match ? match[0] : null;
}

export function buildOleProductUrl(seName: string) {
  return `${OLE_ORIGIN}/${encodeURIComponent(seName.toLowerCase())}`;
}

/**
 * Olé names products sold by the pound "<name> Lb" with no weight
 * ("Chuleta Ahumada Lb", "Carne Molida Premium 95/5 Lb"); fixed packs carry
 * one ("Bacon 1Lb", "Mantequilla 1/2 Lb", "Arroz 5 Lb").
 */
export function isOleSoldByWeight(name: string) {
  const normalized = name.toLowerCase().replace(/\s+/g, " ");
  if (!/\blbs?\b/.test(normalized)) {
    return false;
  }

  const fixedWeight = /(?<![\d./#])\d+(?:[.,]\d+)?\s*lbs?\b/;
  const fraction = /(?<![\d.])\d\/\d\s*lbs?\b/;
  return !fixedWeight.test(normalized) && !fraction.test(normalized);
}

const listingProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  se_name: z.string(),
  product_price: z.object({
    price_value: z.number().nullable(),
    old_price_value: z.number().nullable(),
    disable_buy_button: z.boolean(),
  }),
});

const detailsSchema = z.object({
  id: z.number(),
  name: z.string(),
  se_name: z.string(),
  product_price: z.object({
    price_value: z.number().nullable(),
    old_price_value: z.number().nullable(),
    call_for_price: z.boolean().optional(),
    hide_prices: z.boolean().optional(),
  }),
  add_to_cart: z.object({
    disable_buy_button: z.boolean(),
    allowed_quantities: z.array(z.object({ value: z.string() })).nullable().optional(),
  }),
});

export type OleListingProduct = z.infer<typeof listingProductSchema>;
export type OleProductDetails = z.infer<typeof detailsSchema>;

function toPositivePrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value.toFixed(2)
    : null;
}

function toPrice(
  seName: string,
  unavailable: boolean,
  priceValue: number | null,
  oldPriceValue: number | null,
  purchaseTerms?: PurchaseTerms
): ScrapePriceResult {
  // `disable_buy_button` products cannot be ordered: the product page has no
  // quantity or add-to-cart button. Olé does not manage stock (in_stock is
  // always true), so this is the only availability signal.
  if (unavailable) {
    return notFound(shopId, "unavailable", true);
  }

  const currentPrice = toPositivePrice(priceValue);
  if (!currentPrice) {
    return notFound(shopId, "price_not_found", true);
  }

  const oldPrice = toPositivePrice(oldPriceValue);
  const regularPrice =
    oldPrice && Number(oldPrice) > Number(currentPrice) ? oldPrice : null;

  return ok(
    shopId,
    currentPrice,
    regularPrice,
    null,
    buildOleProductUrl(seName),
    undefined,
    purchaseTerms
  );
}

/** Price of a category listing product; per-pound terms come from the details. */
export function toOleListingPriceResult(
  product: unknown,
  purchaseTerms?: PurchaseTerms
): ScrapePriceResult {
  const parsed = listingProductSchema.safeParse(product);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, false);
  }

  const { se_name, product_price: price } = parsed.data;
  return toPrice(
    se_name,
    price.disable_buy_button,
    price.price_value,
    price.old_price_value,
    purchaseTerms
  );
}

/** Price of a product details payload; `null` means Olé no longer has it. */
export function toOleDetailsPriceResult(details: unknown): ScrapePriceResult {
  if (details === null || details === undefined) {
    return notFound(shopId, "product_not_found", true);
  }

  const parsed = detailsSchema.safeParse(details);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, false);
  }

  const { se_name, name, product_price: price, add_to_cart: cart } = parsed.data;
  if (price.call_for_price || price.hide_prices) {
    return notFound(shopId, "price_not_found", true);
  }

  let purchaseTerms: PurchaseTerms | undefined;
  if (isOleSoldByWeight(name) && !cart.disable_buy_button) {
    purchaseTerms = extractOlePurchaseTerms(parsed.data);
    if (!purchaseTerms) {
      return error(shopId, "purchase_terms_not_found", false, false);
    }
  }

  return toPrice(
    se_name,
    cart.disable_buy_button,
    price.price_value,
    price.old_price_value,
    purchaseTerms
  );
}

/**
 * Per-pound products list the quantities a shopper can pick (1, 2, … 18 lb,
 * or 2, 4, … 40 lb for some cuts), and the price is per pound.
 */
export function extractOlePurchaseTerms(details: OleProductDetails) {
  const quantities = (details.add_to_cart.allowed_quantities ?? [])
    .map((item) => Number(item.value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  const minimum = quantities[0] ?? 1;
  const increment = quantities.length > 1 ? quantities[1] - quantities[0] : 1;
  const evenSteps = quantities.every(
    (value, index) => index === 0 || Math.abs(value - quantities[index - 1] - increment) < 1e-9
  );
  if (!evenSteps) {
    return undefined;
  }

  return buildPurchaseTerms({
    mode: "measure",
    unit: "LB",
    minimum,
    increment,
    maximum: quantities.length > 0 ? quantities[quantities.length - 1] : null,
    priceReferenceQuantity: 1,
    source: OLE_PURCHASE_TERMS_SOURCE,
    evidence: {
      name: details.name,
      allowedQuantities: quantities,
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

/** Request with retries on network errors, 429 and 5xx. 404 is returned as a status, not a failure. */
async function requestJson(
  url: string,
  config: OleApiConfig,
  body?: unknown
): Promise<ApiResponse> {
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
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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

    const json = await response.json().catch(() => undefined);
    if (json === undefined) {
      return { ok: false, reason: "invalid_json" };
    }

    return { ok: true, status: response.status, body: json };
  }

  return { ok: false, reason: lastReason };
}

const rootSchema = z.array(z.object({ id: z.number(), name: z.string() }));

/** The app's root categories (33 on 2026-10-20); every product sits in at least one. */
export async function fetchOleRootCategories(
  config: OleApiConfig
): Promise<{ ok: true; categories: { id: number; name: string }[] } | { ok: false; reason: string }> {
  const response = await requestJson(`${config.apiBaseUrl}/Catalog/GetCatalogRoot`, config);
  if (!response.ok) {
    return response;
  }

  const parsed = rootSchema.safeParse(response.body);
  if (response.status !== 200 || !parsed.success) {
    return { ok: false, reason: "invalid_catalog_root" };
  }

  return { ok: true, categories: parsed.data };
}

const categoryPageSchema = z.object({
  catalog_products_model: z.object({
    products: z.array(z.unknown()).nullable(),
    page_size: z.number(),
    page_size_options: z.array(z.object({ value: z.string() })).nullable().optional(),
    has_next_page: z.boolean(),
    total_items: z.number().optional(),
  }),
});

export type OleCategoryPage = {
  products: unknown[];
  pageSize: number;
  pageSizeOptions: number[];
  hasNextPage: boolean;
  totalItems: number | null;
};

/** One page of a category; Olé answers with its default size when `pageSize` is not offered. */
export async function fetchOleCategoryPage(
  categoryId: number,
  pageNumber: number,
  pageSize: number,
  config: OleApiConfig
): Promise<({ ok: true } & OleCategoryPage) | { ok: false; reason: string }> {
  const response = await requestJson(
    `${config.apiBaseUrl}/Catalog/GetCategoryProducts/${categoryId}`,
    config,
    { page_number: pageNumber, page_size: pageSize }
  );
  if (!response.ok) {
    return response;
  }

  const parsed = categoryPageSchema.safeParse(response.body);
  if (response.status !== 200 || !parsed.success) {
    return { ok: false, reason: "invalid_category_payload" };
  }

  const model = parsed.data.catalog_products_model;
  return {
    ok: true,
    products: model.products ?? [],
    pageSize: model.page_size,
    pageSizeOptions: (model.page_size_options ?? [])
      .map((option) => Number(option.value))
      .filter((value) => Number.isInteger(value) && value > 0),
    hasNextPage: model.has_next_page,
    totalItems: model.total_items ?? null,
  };
}

export type OleCatalog = {
  productsById: Map<string, unknown>;
  categories: number;
  pages: number;
  failures: string[];
};

/**
 * Every product listed in the root categories, keyed by product id. Requests
 * go through `beforeRequest` so the caller controls the pace. A failed page
 * stops that category and is reported in `failures`.
 */
export async function fetchOleCatalog(
  config: OleApiConfig,
  beforeRequest: () => Promise<void>,
  onCategory?: (category: { id: number; name: string }, pages: number, products: number) => void
): Promise<OleCatalog> {
  const catalog: OleCatalog = { productsById: new Map(), categories: 0, pages: 0, failures: [] };

  await beforeRequest();
  const root = await fetchOleRootCategories(config);
  if (!root.ok) {
    catalog.failures.push(`catalog_root:${root.reason}`);
    return catalog;
  }

  catalog.categories = root.categories.length;
  for (const category of root.categories) {
    let pageSize = OLE_PREFERRED_PAGE_SIZE;
    let resized = false;
    const pagesBefore = catalog.pages;
    const listed = new Set<number>();

    for (let page = 1; page <= MAX_PAGES_PER_CATEGORY; page += 1) {
      await beforeRequest();
      const fetched = await fetchOleCategoryPage(category.id, page, pageSize, config);
      if (!fetched.ok) {
        catalog.failures.push(`category_${category.id}_page_${page}:${fetched.reason}`);
        break;
      }
      catalog.pages += 1;

      // The first page tells which sizes the category accepts; restart once
      // with the largest one so the category needs as few requests as possible.
      if (page === 1 && !resized && fetched.pageSize !== pageSize) {
        resized = true;
        const largest = Math.max(fetched.pageSize, ...fetched.pageSizeOptions);
        if (largest > fetched.pageSize) {
          pageSize = largest;
          page = 0;
          continue;
        }
        pageSize = fetched.pageSize;
      }

      for (const product of fetched.products) {
        const id = (product as { id?: unknown } | null)?.id;
        if (typeof id === "number") {
          listed.add(id);
          if (!catalog.productsById.has(String(id))) {
            catalog.productsById.set(String(id), product);
          }
        }
      }

      if (!fetched.hasNextPage || fetched.products.length === 0) {
        break;
      }

      if (page === MAX_PAGES_PER_CATEGORY) {
        catalog.failures.push(`category_${category.id}:too_many_pages`);
      }
    }

    onCategory?.(category, catalog.pages - pagesBefore, listed.size);
  }

  return catalog;
}

/** Product details by Olé product id; `details` is null when Olé no longer has it. */
export async function fetchOleProductDetails(
  productId: string,
  config: OleApiConfig
): Promise<{ ok: true; details: unknown | null } | { ok: false; reason: string }> {
  const response = await requestJson(
    `${config.apiBaseUrl}/Product/GetProductDetails/${encodeURIComponent(productId)}`,
    config
  );
  if (!response.ok) {
    return response;
  }

  if (response.status === 404) {
    return { ok: true, details: null };
  }

  const details = (response.body as { product_details_model?: unknown } | null)
    ?.product_details_model;
  return details === undefined
    ? { ok: false, reason: "invalid_details_payload" }
    : { ok: true, details };
}

/** Single-product lookup; the scheduled job pages through the catalog instead. */
export async function scrapeOlePrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const productId = parseOleProductId(input.api);
  if (!productId) {
    return error(shopId, "missing_product_reference", false, false);
  }

  const fetched = await fetchOleProductDetails(productId, {
    ...getOleApiConfig(),
    timeoutMs: requestConfig?.timeoutMs,
    maxAttempts: requestConfig?.maxRetries,
  });
  if (!fetched.ok) {
    return error(shopId, fetched.reason, true, false);
  }

  return toOleDetailsPriceResult(fetched.details);
}
