import { z } from "zod";
import {
  fetchWithRetryDetailed,
  getJumboHeaders,
} from "../http-client.js";
import {
  buildJumboProductUrl,
  buildJumboProductUrlFromNameAndSku,
  extractJumboSkuCandidates,
} from "../recovery/shared.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 3;
const JUMBO_GRAPHQL_URL = "https://jumbo.com.do/graphql";
const JUMBO_STORE_CODE_ENV = "JUMBO_STORE_CODE";
const DEFAULT_JUMBO_STORE_CODE = "jumbo";

const jumboProductQuery = `query JumboProductBySku($sku: String!) {
  products(filter: { sku: { eq: $sku } }) {
    items {
      sku
      name
      url_key
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

const jumboProductResponseSchema = z.object({
  data: z.object({
    products: z.object({
      items: z
        .array(
          z.object({
            sku: z.string(),
            name: z.string().nullable().optional(),
            url_key: z.string().nullable().optional(),
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
        )
        .default([]),
    }),
  }),
});

function toPriceString(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value)
    ? null
    : String(value);
}

function resolveJumboStoreCode() {
  const storeCode = process.env[JUMBO_STORE_CODE_ENV]?.trim();
  return storeCode || DEFAULT_JUMBO_STORE_CODE;
}

export async function scrapeJumboPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const skuCandidates = extractJumboSkuCandidates(input.url);
  if (skuCandidates.length === 0) {
    return error(shopId, "invalid_jumbo_sku", false, true);
  }

  const headers = getJumboHeaders();
  for (const sku of skuCandidates) {
    const result = await fetchWithRetryDetailed(
      JUMBO_GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          ...headers,
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: "https://jumbo.com.do",
          Referer: input.url,
          store: resolveJumboStoreCode(),
        },
        body: JSON.stringify({
          query: jumboProductQuery,
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

    const parsedResponse = jumboProductResponseSchema.safeParse(
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
      continue;
    }

    const finalPrice = toPriceString(
      product.price_range?.minimum_price.final_price.value ?? null
    );

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

    return ok(
      shopId,
      finalPrice,
      regularPrice,
      null,
      product.url_key
        ? buildJumboProductUrl(product.url_key)
        : product.name
          ? buildJumboProductUrlFromNameAndSku(product.name, product.sku)
          : null
    );
  }

  return notFound(shopId, "product_not_found", true);
}
