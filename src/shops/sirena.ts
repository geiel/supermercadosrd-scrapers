import { z } from "zod";
import { fetchWithRetry, getSirenaHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 1;

const productSchema = z
  .object({
    product: z.object({
      thumbs: z.string(),
      category: z.string(),
      price: z.string(),
      regular_price: z.string(),
    }),
  })
  .or(
    z.object({
      message: z.string(),
    })
  );

export async function scrapeSirenaPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  if (!input.api) {
    return error(shopId, "missing_api", false, false);
  }

  const response = await fetchWithRetry(
    input.api,
    { headers: getSirenaHeaders() },
    requestConfig
  );

  if (!response) {
    return error(shopId, "request_failed", true, false);
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  if (!jsonResponse) {
    return error(shopId, "invalid_json", true, false);
  }

  const parsed = productSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, true);
  }

  if ("message" in parsed.data) {
    return notFound(shopId, parsed.data.message, true);
  }

  return ok(shopId, parsed.data.product.price, parsed.data.product.regular_price);
}
