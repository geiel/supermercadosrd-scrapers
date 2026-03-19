import * as cheerio from "cheerio";
import { fetchWithRetry, getNacionalHeaders } from "../http-client.js";
import { dedupeComparableUrls, normalizeNacionalImageUrl, toAbsoluteUrl } from "../image-utils.js";
import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";

const shopId = 2;
const shopName = "nacional";

function extractNacionalImages(url: string, html: string) {
  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ??
    $("title").first().text().trim();

  if (title.includes("404 Página no encontrada")) {
    return { notFound: true, images: [] as string[] };
  }

  const images = dedupeComparableUrls([
    $('meta[property="og:image"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
    $('img.fotorama__img').attr("src"),
    $(".gallery-placeholder__image").attr("src"),
    $("img.product-image-photo").attr("src"),
  ])
    .map((imageUrl) => toAbsoluteUrl(imageUrl, url))
    .map(normalizeNacionalImageUrl);

  return { notFound: false, images };
}

export async function scrapeNacionalImages(
  input: ScrapeProductImagesInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapeProductImagesResult> {
  const response = await fetchWithRetry(
    input.url,
    { headers: getNacionalHeaders() },
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

  if (response.status === 404) {
    return {
      status: "not_found",
      shopId,
      shopName,
      reason: "product_not_found",
    };
  }

  const html = await response.text().catch(() => "");
  if (!html) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "empty_html",
      retryable: true,
    };
  }

  const extracted = extractNacionalImages(input.url, html);
  if (extracted.notFound) {
    return {
      status: "not_found",
      shopId,
      shopName,
      reason: "product_not_found",
    };
  }

  if (extracted.images.length === 0) {
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
    images: extracted.images,
  };
}
