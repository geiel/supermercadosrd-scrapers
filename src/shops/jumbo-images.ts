import { z } from "zod";
import {
  fetchWithRetryDetailed,
  getJumboHeaders,
} from "../http-client.js";
import { extractJumboSkuCandidates } from "../recovery/shared.js";
import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";
import {
  extractJumboImageUrls,
  JUMBO_GRAPHQL_URL,
  jumboImageGraphqlFields,
  resolveJumboStoreCode,
} from "./jumbo-shared.js";

const shopId = 3;
const shopName = "jumbo";

const jumboImagesQuery = `query JumboImagesBySku($sku: String!) {
  products(filter: { sku: { eq: $sku } }) {
    items {
      sku
${jumboImageGraphqlFields}
    }
  }
}`;

const jumboImagesResponseSchema = z.object({
  data: z.object({
    products: z.object({
      items: z
        .array(
          z.object({
            sku: z.string(),
            image: z
              .object({
                url: z.string().nullable().optional(),
              })
              .nullable()
              .optional(),
            small_image: z
              .object({
                url: z.string().nullable().optional(),
              })
              .nullable()
              .optional(),
            thumbnail: z
              .object({
                url: z.string().nullable().optional(),
              })
              .nullable()
              .optional(),
            media_gallery: z
              .array(
                z.object({
                  url: z.string().nullable().optional(),
                  disabled: z.boolean().nullable().optional(),
                })
              )
              .nullable()
              .optional(),
          })
        )
        .default([]),
    }),
  }),
});

export async function scrapeJumboImages(
  input: ScrapeProductImagesInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapeProductImagesResult> {
  const skuCandidates = extractJumboSkuCandidates(input.url);
  if (skuCandidates.length === 0) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "invalid_jumbo_sku",
      retryable: false,
    };
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
          query: jumboImagesQuery,
          variables: {
            sku,
          },
        }),
      },
      requestConfig
    );

    if (!result.response) {
      return {
        status: "error",
        shopId,
        shopName,
        reason: result.failureReason,
        retryable: true,
      };
    }

    if (!result.response.ok) {
      return {
        status: "error",
        shopId,
        shopName,
        reason: `http_${result.response.status}`,
        retryable: result.response.status >= 500 || result.response.status === 429,
      };
    }

    const parsedResponse = jumboImagesResponseSchema.safeParse(
      await result.response.json().catch(() => null)
    );
    if (!parsedResponse.success) {
      return {
        status: "error",
        shopId,
        shopName,
        reason: "invalid_payload",
        retryable: false,
      };
    }

    const product =
      parsedResponse.data.data.products.items.find(
        (candidate) => candidate.sku === sku
      ) ?? null;

    if (!product) {
      continue;
    }

    const images = extractJumboImageUrls(product);

    if (images.length === 0) {
      return {
        status: "not_found",
        shopId,
        shopName,
        reason: "image_not_found",
      };
    }

    return {
      status: "ok",
      shopId,
      shopName,
      images,
    };
  }

  return {
    status: "not_found",
    shopId,
    shopName,
    reason: "product_not_found",
  };
}
