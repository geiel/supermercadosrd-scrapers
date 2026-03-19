import { fetchWithRetry, getSirenaHeaders } from "../http-client.js";
import { dedupeUrls, isRecord, normalizeString } from "../image-utils.js";
import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";

const shopId = 1;
const shopName = "sirena";
const sirenaImageBaseUrl =
  "https://assets-sirenago.s3-us-west-1.amazonaws.com/product/original";

function normalizeSirenaImageUrl(imageUrl: string) {
  const normalizedImageUrl = normalizeString(imageUrl);
  if (!normalizedImageUrl) {
    return "";
  }

  if (/^https?:\/\//i.test(normalizedImageUrl)) {
    return normalizedImageUrl;
  }

  return `${sirenaImageBaseUrl}/${normalizedImageUrl.replace(/^\/+/, "")}`;
}

function extractSirenaImages(payload: unknown) {
  if (!isRecord(payload)) {
    return [];
  }

  const product = isRecord(payload.product) ? payload.product : null;
  const thumbs = normalizeString(product?.thumbs);

  return dedupeUrls([
    normalizeSirenaImageUrl(thumbs),
  ]);
}

export async function scrapeSirenaImages(
  input: ScrapeProductImagesInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapeProductImagesResult> {
  if (!input.api) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "missing_api",
      retryable: false,
    };
  }

  const response = await fetchWithRetry(
    input.api,
    { headers: getSirenaHeaders() },
    requestConfig
  );

  if (!response) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "request_failed",
      retryable: true,
    };
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!payload) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "invalid_json",
      retryable: true,
    };
  }

  if (isRecord(payload) && normalizeString(payload.message)) {
    return {
      status: "not_found",
      shopId,
      shopName,
      reason: normalizeString(payload.message),
    };
  }

  const images = extractSirenaImages(payload);
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
