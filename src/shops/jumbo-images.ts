import * as cheerio from "cheerio";
import { z } from "zod";
import { fetchWithBrowserDetailed } from "../http-client.js";
import { dedupeUrls, isRecord, toAbsoluteUrl } from "../image-utils.js";
import type {
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";

const shopId = 3;
const shopName = "jumbo";
const jumboPlaceholderImagePath =
  "/pub/media/catalog/product/placeholder/default/jumbo-placeholder.png";
const jumboCachedImagePathPattern =
  /\/pub\/media\/catalog\/product\/cache\/[^/]+\//i;

const jumboImageSchema = z.object({
  product: z.object({
    image_url: z.string(),
  }),
});

function normalizeJumboImageUrl(imageUrl: string) {
  try {
    const parsedUrl = new URL(imageUrl);
    parsedUrl.pathname = parsedUrl.pathname.replace(
      jumboCachedImagePathPattern,
      "/pub/media/catalog/product/"
    );
    return parsedUrl.toString();
  } catch {
    return imageUrl.replace(
      jumboCachedImagePathPattern,
      "/pub/media/catalog/product/"
    );
  }
}

function extractJumboImages(url: string, html: string) {
  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ??
    $("title").first().text().trim();

  if (title.toLowerCase().includes("404")) {
    return { notFound: true, images: [] as string[] };
  }

  const scriptContent = $('script[type="text/x-magento-init"]').html();
  let gtmImageUrl = "";

  if (scriptContent) {
    const parsed = JSON.parse(scriptContent) as Record<string, unknown>;
    const starRecord = isRecord(parsed["*"]) ? parsed["*"] : null;
    const gtmDataLayer = isRecord(starRecord?.magepalGtmDatalayer)
      ? starRecord.magepalGtmDatalayer
      : null;
    const dataArray = Array.isArray(gtmDataLayer?.data) ? gtmDataLayer.data : [];

    const parsedImage = jumboImageSchema.safeParse(dataArray[1]);
    if (parsedImage.success) {
      gtmImageUrl = parsedImage.data.product.image_url;
    }
  }

  const images = dedupeUrls([
    gtmImageUrl,
    $('meta[property="og:image"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
    $(".gallery-placeholder__image").attr("src"),
    $("img.product-image-photo").attr("src"),
  ])
    .map((imageUrl) => toAbsoluteUrl(imageUrl, url))
    .map(normalizeJumboImageUrl)
    .filter(
      (imageUrl) =>
        !imageUrl.toLowerCase().includes(jumboPlaceholderImagePath)
    );

  return { notFound: false, images };
}

export async function scrapeJumboImages(
  input: ScrapeProductImagesInput
): Promise<ScrapeProductImagesResult> {
  const response = await fetchWithBrowserDetailed(input.url);
  if (!response.ok) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: response.reason,
      retryable: response.reason !== "blocked",
    };
  }

  const extracted = extractJumboImages(input.url, response.html);
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
