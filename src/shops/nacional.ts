import * as cheerio from "cheerio";
import { fetchWithRetry, getNacionalHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 2;
const NACIONAL_HOST = "supermercadosnacional.com";

export type NacionalPageInspectionResult =
  | {
      status: "ok";
      html: string;
      finalPrice: string | null;
      oldPrice: string | null;
    }
  | {
      status: "not_found";
      reason: string;
      hide: boolean;
    }
  | {
      status: "error";
      reason: string;
      retryable: boolean;
      hide: boolean;
    };

export async function inspectNacionalProductPage(
  url: string,
  requestConfig?: FetchWithRetryConfig
): Promise<NacionalPageInspectionResult> {
  const response = await fetchWithRetry(
    url,
    { headers: getNacionalHeaders() },
    requestConfig
  );

  if (!response) {
    return {
      status: "error",
      reason: "request_failed",
      retryable: true,
      hide: false,
    };
  }

  try {
    const responseHost = new URL(response.url).host;
    if (responseHost !== NACIONAL_HOST) {
      return {
        status: "not_found",
        reason: "redirected_to_foreign_host",
        hide: true,
      };
    }
  } catch {
    return {
      status: "error",
      reason: "invalid_response_url",
      retryable: false,
      hide: false,
    };
  }

  if (response.status === 404) {
    return {
      status: "not_found",
      reason: "product_not_found",
      hide: true,
    };
  }

  const html = await response.text().catch(() => "");
  if (!html) {
    return {
      status: "error",
      reason: "empty_html",
      retryable: true,
      hide: false,
    };
  }

  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ??
    $("title").first().text().trim();

  if (title.includes("404 Página no encontrada")) {
    return {
      status: "not_found",
      reason: "product_not_found",
      hide: true,
    };
  }

  if (title.includes("503 backend read error")) {
    return {
      status: "error",
      reason: "backend_503",
      retryable: true,
      hide: false,
    };
  }

  const finalPrice = $('span[data-price-type="finalPrice"]').attr(
    "data-price-amount"
  );
  const oldPrice = $('span[data-price-type="oldPrice"]').attr(
    "data-price-amount"
  );

  return {
    status: "ok",
    html,
    finalPrice: finalPrice ?? null,
    oldPrice: oldPrice ?? null,
  };
}

export async function scrapeNacionalPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const pageInspection = await inspectNacionalProductPage(input.url, requestConfig);

  if (pageInspection.status === "not_found") {
    return notFound(shopId, pageInspection.reason, pageInspection.hide);
  }

  if (pageInspection.status === "error") {
    return error(
      shopId,
      pageInspection.reason,
      pageInspection.retryable,
      pageInspection.hide
    );
  }

  if (!pageInspection.finalPrice) {
    return error(shopId, "price_not_found", false, false);
  }

  return ok(shopId, pageInspection.finalPrice, pageInspection.oldPrice ?? null);
}
