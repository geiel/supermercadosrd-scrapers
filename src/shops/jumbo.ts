import * as cheerio from "cheerio";
import { fetchWithBrowserDetailed } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type { ScrapePriceInput, ScrapePriceResult } from "../types.js";

const shopId = 3;

function isJumboDebugEnabled(): boolean {
  return (
    process.env.SCRAPER_DEBUG_JUMBO === "1" ||
    process.env.SCRAPER_DEBUG_JUMBO === "true" ||
    process.env.GITHUB_ACTIONS === "true"
  );
}

function logJumboDebug(message: string, context?: Record<string, unknown>): void {
  if (!isJumboDebugEnabled()) {
    return;
  }

  if (context) {
    console.log(`[JUMBO_DEBUG] ${message}`, context);
    return;
  }

  console.log(`[JUMBO_DEBUG] ${message}`);
}

export async function scrapeJumboPrice(
  input: ScrapePriceInput
): Promise<ScrapePriceResult> {
  logJumboDebug("scrape_start", { url: input.url });
  const response = await fetchWithBrowserDetailed(input.url);
  if (!response.ok) {
    const retryable = response.reason !== "blocked";
    logJumboDebug("scrape_fetch_failed", {
      url: input.url,
      reason: response.reason,
      retryable,
    });
    return error(shopId, response.reason, retryable, false);
  }

  const { html } = response;

  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ??
    $("title").first().text().trim();
  logJumboDebug("scrape_parsed_title", { url: input.url, title });

  if (title.toLowerCase().includes("404")) {
    logJumboDebug("scrape_product_not_found_by_title", { url: input.url, title });
    return notFound(shopId, "product_not_found", true);
  }

  const finalPrice = $('span[data-price-type="finalPrice"]').attr(
    "data-price-amount"
  );
  const oldPrice = $('span[data-price-type="oldPrice"]').attr(
    "data-price-amount"
  );
  logJumboDebug("scrape_price_selectors", {
    url: input.url,
    hasFinalPrice: Boolean(finalPrice),
    hasOldPrice: Boolean(oldPrice),
  });

  if (!finalPrice) {
    logJumboDebug("scrape_price_not_found", { url: input.url, title });
    return notFound(shopId, "price_not_found", true);
  }

  logJumboDebug("scrape_ok", {
    url: input.url,
    currentPrice: finalPrice,
    regularPrice: oldPrice ?? null,
  });
  return ok(shopId, finalPrice, oldPrice ?? null);
}
