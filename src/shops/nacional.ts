import * as cheerio from "cheerio";
import { z } from "zod";
import { NACIONAL_REST_API_URL } from "../api-endpoints.js";
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
import { fetchMagentoGraphqlItemsBySku } from "./magento-graphql-batch.js";

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

  return `${NACIONAL_REST_API_URL}?${params.toString()}`;
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

function parseMagentoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.trim().replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
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

function isSpecialPriceActive(
  specialFromDate: unknown,
  specialToDate: unknown,
  now = new Date()
): boolean {
  const fromDate = parseMagentoDate(specialFromDate);
  const toDate = parseMagentoDate(specialToDate);

  if (fromDate && now < fromDate) {
    return false;
  }

  if (toDate && now > toDate) {
    return false;
  }

  return true;
}

export type NacionalPriceFields = {
  price: unknown;
  specialPrice: unknown;
  specialFromDate: unknown;
  specialToDate: unknown;
};

// The REST lookup's rule: the special price while its dates allow it.
export function toNacionalPriceResult(
  fields: NacionalPriceFields,
  now = new Date()
): ScrapePriceResult {
  const regularPrice = parsePrice(fields.price);
  const specialPrice = parsePrice(fields.specialPrice);

  if (regularPrice === null) {
    return error(shopId, "price_not_found", false, false);
  }

  if (
    specialPrice !== null &&
    specialPrice > 0 &&
    specialPrice < regularPrice &&
    isSpecialPriceActive(fields.specialFromDate, fields.specialToDate, now)
  ) {
    return ok(shopId, specialPrice.toString(), regularPrice.toString());
  }

  return ok(shopId, regularPrice.toString(), null);
}

export async function scrapeNacionalPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const sku = extractNacionalSku(input.url);
  if (!sku) {
    return error(shopId, "invalid_nacional_sku", false, true);
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
      result.response.status >= 500 || result.response.status === 429,
      false
    );
  }

  const payload = (await result.response
    .json()
    .catch(() => null)) as NacionalProductLookupResponse | null;
  if (!payload || !Array.isArray(payload.items)) {
    return error(shopId, "invalid_payload", false, false);
  }

  const product = payload.items.find((item) => item.sku === sku);

  if (!product) {
    return notFound(shopId, "product_not_found", true);
  }

  if (Number(product.status) !== 1 || !isNacionalWebsiteProduct(product)) {
    return notFound(shopId, "product_not_found", true);
  }

  return toNacionalPriceResult({
    price: product.price,
    specialPrice: getAttributeValue(product, "special_price"),
    specialFromDate: getAttributeValue(product, "special_from_date"),
    specialToDate: getAttributeValue(product, "special_to_date"),
  });
}

const NACIONAL_GRAPHQL_URL = "https://supermercadosnacional.com/graphql";
const NACIONAL_GRAPHQL_STORE_CODE = "default";

// GraphQL only lists products that are enabled on the Nacional website, which
// the REST lookup checks through status and website_ids. A SKU it leaves out
// is looked up through REST, which decides whether to hide the price.
//
// The batch takes Magento's own final_price, the price the Nacional website
// shows and charges, as Jumbo and Merca Jumbo do. It does not re-apply
// special_from_date/special_to_date: on 2026-11-01 Nacional still charged the
// special price of offers whose special_to_date had passed (36 of 40 sampled
// price changes), and the dates read in UTC end offers 4 hours early.
const nacionalPricesBySkuQuery = `query NacionalPricesBySku($skus: [String!]!, $pageSize: Int!) {
  products(filter: { sku: { in: $skus } }, pageSize: $pageSize) {
    total_count
    items {
      sku
      price_range {
        minimum_price {
          final_price {
            value
          }
          regular_price {
            value
          }
        }
      }
    }
  }
}`;

const nacionalGraphqlPriceItemSchema = z.object({
  sku: z.string(),
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
});

export type NacionalGraphqlPriceItem = z.infer<typeof nacionalGraphqlPriceItemSchema>;

export function toNacionalGraphqlPriceResult(
  item: NacionalGraphqlPriceItem
): ScrapePriceResult {
  const regularPrice = parsePrice(item.price_range?.minimum_price.regular_price.value);
  const finalPrice = parsePrice(item.price_range?.minimum_price.final_price.value);

  if (regularPrice === null || finalPrice === null) {
    return error(shopId, "price_not_found", false, false);
  }

  if (finalPrice > 0 && finalPrice < regularPrice) {
    return ok(shopId, finalPrice.toString(), regularPrice.toString());
  }

  return ok(shopId, regularPrice.toString(), null);
}

export async function fetchNacionalGraphqlPricesBySkus(
  skus: string[],
  requestConfig?: FetchWithRetryConfig
) {
  return fetchMagentoGraphqlItemsBySku(
    {
      url: NACIONAL_GRAPHQL_URL,
      storeCode: NACIONAL_GRAPHQL_STORE_CODE,
      query: nacionalPricesBySkuQuery,
      skus,
      itemSchema: nacionalGraphqlPriceItemSchema,
      headers: {
        Referer: "https://supermercadosnacional.com/",
        "User-Agent": getNacionalHeaders()["User-Agent"],
      },
    },
    requestConfig
  );
}
