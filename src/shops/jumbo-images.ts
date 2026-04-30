import { z } from "zod";
import {
  fetchWithRetryDetailed,
  getJumboHeaders,
} from "../http-client.js";
import {
  dedupeComparableUrls,
  normalizeNacionalImageUrl,
} from "../image-utils.js";
import { extractJumboUrlTail } from "../recovery/shared.js";
import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";

const shopId = 3;
const shopName = "jumbo";
const JUMBO_GRAPHQL_URL = "https://jumbo.com.do/graphql";

const jumboImagesQuery = `query JumboImagesBySku($sku: String!) {
  products(filter: { sku: { eq: $sku } }) {
    items {
      sku
      image {
        url
      }
      small_image {
        url
      }
      thumbnail {
        url
      }
      media_gallery {
        url
        disabled
      }
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
  const sku = extractJumboUrlTail(input.url);
  if (!sku) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "invalid_jumbo_sku",
      retryable: false,
    };
  }

  const headers = getJumboHeaders();
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
    return {
      status: "not_found",
      shopId,
      shopName,
      reason: "product_not_found",
    };
  }

  const images = dedupeComparableUrls([
    product.image?.url,
    product.small_image?.url,
    product.thumbnail?.url,
    ...(product.media_gallery ?? [])
      .filter((image) => !image.disabled)
      .map((image) => image.url),
  ]).map(normalizeNacionalImageUrl);

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
