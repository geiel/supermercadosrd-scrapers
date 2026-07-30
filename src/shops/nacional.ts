import * as cheerio from "cheerio";
import { z } from "zod";
import {
  fetchWithRetryDetailed,
  getNacionalHeaders,
} from "../http-client.js";
import { extractNacionalSku } from "../recovery/shared.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";
import {
  extractMagentoGraphqlPurchaseTerms,
  magentoPurchaseTermsGraphqlFields,
  magentoPurchaseTermsGraphqlSchema,
} from "./magento-graphql-purchase-terms.js";

const shopId = 2;
const NACIONAL_HOST = "supermercadosnacional.com";
const NACIONAL_GRAPHQL_URL = `https://${NACIONAL_HOST}/graphql`;

const nacionalProductQuery = `query NacionalProductBySku($sku: String!) {
  products(filter: { sku: { eq: $sku } }) {
    items {
      sku
${magentoPurchaseTermsGraphqlFields}
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

const nacionalProductResponseSchema = z.object({
  data: z.object({
    products: z.object({
      items: z
        .array(
          z
            .object({
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
            })
            .merge(magentoPurchaseTermsGraphqlSchema)
        )
        .default([]),
    }),
  }),
});

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

function toPriceString(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value)
    ? null
    : String(value);
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
    NACIONAL_GRAPHQL_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://supermercadosnacional.com",
        Referer: "https://supermercadosnacional.com/",
        "User-Agent": getNacionalHeaders()["User-Agent"],
      },
      body: JSON.stringify({
        query: nacionalProductQuery,
        variables: {
          sku,
        },
      }),
    },
    requestConfig
  );

  if (!result.response) {
    return error(shopId, result.failureReason, true, false);
  }

  if (!result.response.ok) {
    return error(
      shopId,
      `http_${result.response.status}`,
      result.response.status >= 500 || result.response.status === 429,
      false
    );
  }

  const parsedResponse = nacionalProductResponseSchema.safeParse(
    await result.response.json().catch(() => null)
  );
  if (!parsedResponse.success) {
    return error(shopId, "invalid_payload", false, false);
  }

  const product =
    parsedResponse.data.data.products.items.find(
      (candidate) => candidate.sku === sku
    ) ?? null;

  if (!product) {
    return notFound(shopId, "product_not_found", true);
  }

  const finalPriceValue =
    product.price_range?.minimum_price.final_price.value ?? null;
  const finalPrice = toPriceString(finalPriceValue);
  if (!finalPrice) {
    return error(shopId, "price_not_found", false, false);
  }

  const regularPriceValue =
    product.price_range?.minimum_price.regular_price.value ?? null;
  const regularPrice =
    regularPriceValue !== null &&
    regularPriceValue !== undefined &&
    regularPriceValue > Number(finalPrice)
      ? toPriceString(regularPriceValue)
      : null;
  const purchaseTerms = extractMagentoGraphqlPurchaseTerms(product, {
    source: "nacional_graphql",
    productUnit: input,
  });

  return ok(
    shopId,
    finalPrice,
    regularPrice,
    null,
    undefined,
    undefined,
    purchaseTerms
  );
}
