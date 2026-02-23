import * as cheerio from "cheerio";
import { fetchWithBrowser } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type { ScrapePriceInput, ScrapePriceResult } from "../types.js";

const shopId = 3;

export async function scrapeJumboPrice(
  input: ScrapePriceInput
): Promise<ScrapePriceResult> {
  const html = await fetchWithBrowser(input.url);
  if (!html) {
    return error(shopId, "request_failed", true, false);
  }

  const $ = cheerio.load(html);
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
