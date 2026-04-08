import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";
import {
  extractMercaJumboSkuFromUrl,
  fetchMercaJumboProductBySku,
} from "./merca-jumbo-shared.js";

const shopId = 7;
const shopName = "merca_jumbo";

export async function scrapeMercaJumboImages(
  input: ScrapeProductImagesInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapeProductImagesResult> {
  const sku = extractMercaJumboSkuFromUrl(input.url);
  const productLookup = await fetchMercaJumboProductBySku(
    {
      sku,
      api: input.api,
    },
    requestConfig
  );

  if (productLookup.status === "not_found") {
    return {
      status: "not_found",
      shopId,
      shopName,
      reason: productLookup.reason,
    };
  }

  if (productLookup.status === "error") {
    return {
      status: "error",
      shopId,
      shopName,
      reason: productLookup.reason,
      retryable: productLookup.retryable,
    };
  }

  if (productLookup.product.imageUrls.length === 0) {
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
    images: productLookup.product.imageUrls,
  };
}
