import * as cheerio from "cheerio";
import { fetchWithRetry, getNacionalHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 2;

export async function scrapeNacionalPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const response = await fetchWithRetry(
    input.url,
    { headers: getNacionalHeaders() },
    requestConfig
  );

  if (!response) {
    return error(shopId, "request_failed", true, false);
  }

  const html = await response.text().catch(() => "");
  if (!html) {
    return error(shopId, "empty_html", true, false);
  }

  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ??
    $("title").first().text().trim();

  if (title.includes("404 Página no encontrada")) {
    return notFound(shopId, "product_not_found", true);
  }

  const finalPrice = $('span[data-price-type="finalPrice"]').attr(
    "data-price-amount"
  );
  const oldPrice = $('span[data-price-type="oldPrice"]').attr(
    "data-price-amount"
  );

  if (!finalPrice) {
    if (title.includes("503 backend read error")) {
      return error(shopId, "backend_503", true, false);
    }

    return error(shopId, "price_not_found", false, false);
  }

  return ok(shopId, finalPrice, oldPrice ?? null);
}
