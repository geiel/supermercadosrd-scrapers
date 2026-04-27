import * as cheerio from "cheerio";
import {
  fetchWithRetryDetailed,
  getNacionalHeaders,
  type FetchFailureReason,
} from "../http-client.js";
import { extractNacionalSku } from "../recovery/shared.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 2;
const NACIONAL_HOST = "supermercadosnacional.com";
const NACIONAL_WEBSITE_ID = 1;

type NacionalProductLookupResponse = {
  items?: Array<{
    sku?: string;
    status?: unknown;
    price?: unknown;
    extension_attributes?: {
      website_ids?: unknown;
    };
    custom_attributes?: Array<{
      attribute_code?: string;
      value?: unknown;
    }>;
  }>;
};

export type NacionalPageInspectionResult =
  | {
      status: "ok";
      html: string;
      finalPrice: string | null;
      oldPrice: string | null;
    }
  | {
      status: "not_found";
      reason: string;
      hide: boolean;
    }
  | {
      status: "error";
      reason: string;
      retryable: boolean;
      hide: boolean;
    };

export async function inspectNacionalProductPage(
  url: string,
  requestConfig?: FetchWithRetryConfig
): Promise<NacionalPageInspectionResult> {
  const result = await fetchWithRetryDetailed(
    url,
    { headers: getNacionalHeaders() },
    requestConfig
  );
  const response = result.response;

  if (!response) {
    return {
      status: "error",
      reason: result.failureReason,
      retryable: true,
      hide: false,
    };
  }

  try {
    const responseHost = new URL(response.url).host;
    if (responseHost !== NACIONAL_HOST) {
      return {
        status: "not_found",
        reason: "redirected_to_foreign_host",
        hide: true,
      };
    }
  } catch {
    return {
      status: "error",
      reason: "invalid_response_url",
      retryable: false,
      hide: false,
    };
  }

  if (response.status === 404) {
    return {
      status: "not_found",
      reason: "product_not_found",
      hide: true,
    };
  }

  const html = await response.text().catch(() => "");
  if (!html) {
    return {
      status: "error",
      reason: "empty_html",
      retryable: true,
      hide: false,
    };
  }

  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ??
    $("title").first().text().trim();

  if (title.includes("404 Página no encontrada")) {
    return {
      status: "not_found",
      reason: "product_not_found",
      hide: true,
    };
  }

  if (title.includes("503 backend read error")) {
    return {
      status: "error",
      reason: "backend_503",
      retryable: true,
      hide: false,
    };
  }

  const finalPrice = $('span[data-price-type="finalPrice"]').attr(
    "data-price-amount"
  );
  const oldPrice = $('span[data-price-type="oldPrice"]').attr(
    "data-price-amount"
  );

  return {
    status: "ok",
    html,
    finalPrice: finalPrice ?? null,
    oldPrice: oldPrice ?? null,
  };
}

function buildNacionalProductLookupUrl(sku: string): string {
  const params = new URLSearchParams({
    "searchCriteria[filter_groups][0][filters][0][field]": "sku",
    "searchCriteria[filter_groups][0][filters][0][value]": sku,
    "searchCriteria[filter_groups][0][filters][0][condition_type]": "eq",
    fields:
      "items[sku,status,price,extension_attributes[website_ids],custom_attributes[attribute_code,value]],total_count",
  });

  return `https://supermercadosnacional.com/rest/default/V1/products?${params.toString()}`;
}

function parsePrice(value: unknown): number | null {
  const price =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;

  return Number.isFinite(price) ? price : null;
}

function getAttributeValue(
  product: NonNullable<NacionalProductLookupResponse["items"]>[number],
  code: string
): unknown {
  return product.custom_attributes?.find(
    (attribute) => attribute.attribute_code === code
  )?.value;
}

function isNacionalWebsiteProduct(
  product: NonNullable<NacionalProductLookupResponse["items"]>[number]
): boolean {
  const websiteIds = product.extension_attributes?.website_ids;
  if (!Array.isArray(websiteIds)) {
    return false;
  }

  return websiteIds.some((websiteId) => Number(websiteId) === NACIONAL_WEBSITE_ID);
}

async function scrapeNacionalPriceFromRest(
  url: string,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult | null> {
  const sku = extractNacionalSku(url);
  if (!sku) {
    return null;
  }

  const result = await fetchWithRetryDetailed(
    buildNacionalProductLookupUrl(sku),
    {
      headers: {
        Accept: "application/json",
        Referer: "https://supermercadosnacional.com/",
        "User-Agent": getNacionalHeaders()["User-Agent"],
      },
    },
    requestConfig
  );

  if (!result.response) {
    return error(shopId, result.failureReason, true, false);
  }

  if (!result.response.ok) {
    return error(
      shopId,
      `http_${result.response.status}` satisfies FetchFailureReason,
      true,
      false
    );
  }

  const payload = (await result.response
    .json()
    .catch(() => null)) as NacionalProductLookupResponse | null;
  const product = payload?.items?.find((item) => item.sku === sku);

  if (!product) {
    return notFound(shopId, "product_not_found", true);
  }

  if (Number(product.status) !== 1) {
    return notFound(shopId, "product_not_found", true);
  }

  if (!isNacionalWebsiteProduct(product)) {
    return notFound(shopId, "product_not_found", true);
  }

  const regularPrice = parsePrice(product.price);
  const specialPrice = parsePrice(getAttributeValue(product, "special_price"));

  if (regularPrice === null) {
    return error(shopId, "price_not_found", false, false);
  }

  if (specialPrice !== null && specialPrice > 0 && specialPrice < regularPrice) {
    return ok(shopId, specialPrice.toString(), regularPrice.toString());
  }

  return ok(shopId, regularPrice.toString(), null);
}

export async function scrapeNacionalPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  return (
    (await scrapeNacionalPriceFromRest(input.url, requestConfig)) ??
    error(shopId, "invalid_nacional_sku", false, false)
  );
}
