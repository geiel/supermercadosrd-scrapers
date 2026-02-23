import * as cheerio from "cheerio";
import { fetchWithBrowserDetailed } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type { ScrapePriceInput, ScrapePriceResult } from "../types.js";

const shopId = 3;

export async function scrapeJumboPrice(
  input: ScrapePriceInput
): Promise<ScrapePriceResult> {
  const response = await fetchWithBrowserDetailed(input.url);
  if (!response.ok) {
    const retryable = response.reason !== "blocked";
    return error(shopId, response.reason, retryable, false);
  }

  const { html } = response;

  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ??
    $("title").first().text().trim();

  if (title.toLowerCase().includes("404")) {
    return notFound(shopId, "product_not_found", true);
  }

  const finalPrice = $('span[data-price-type="finalPrice"]').attr(
    "data-price-amount"
  );
  const oldPrice = $('span[data-price-type="oldPrice"]').attr(
    "data-price-amount"
  );

  if (!finalPrice) {
    return notFound(shopId, "price_not_found", true);
  }

  return ok(shopId, finalPrice, oldPrice ?? null);
}
