import { z } from "zod";
import { fetchWithRetry, getPricesmartHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 5;

const responseSchema = z.object({
  data: z.object({
    products: z.object({
      results: z.array(
        z.object({
          masterData: z.object({
            current: z.object({
              allVariants: z.array(
                z.object({
                  attributesRaw: z.array(
                    z.object({
                      name: z.string(),
                      value: z.unknown(),
                    })
                  ),
                })
              ),
            }),
          }),
        })
      ),
    }),
  }),
});

const countryPriceSchema = z.array(
  z.object({
    country: z.string(),
    value: z.string(),
  })
);

function parseCountryPrice(raw: unknown) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = countryPriceSchema.safeParse(JSON.parse(String(raw)));
    if (!parsed.success) {
      return null;
    }

    return parsed.data.find((price) => price.country === "DO") ?? null;
  } catch {
    return null;
  }
}

export async function scrapePricesmartPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  if (!input.api) {
    return error(shopId, "missing_api", false, true);
  }

  const response = await fetchWithRetry(
    "https://www.pricesmart.com/api/ct/getProduct",
    {
      method: "POST",
      body: JSON.stringify([
        { skus: [input.api] },
        { products: "getProductBySKU" },
      ]),
      headers: getPricesmartHeaders(),
    },
    requestConfig
  );

  if (!response) {
    return error(shopId, "request_failed", true, true);
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  if (!jsonResponse) {
    return error(shopId, "invalid_json", true, true);
  }

  const parsed = responseSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, true);
  }

  const result = parsed.data.data.products.results[0];
  if (!result) {
    return notFound(shopId, "product_not_found", true);
  }

  const attributes = result.masterData.current.allVariants[0]?.attributesRaw ?? [];
  const unitPrice = attributes.find((attr) => attr.name === "unit_price");
  if (!unitPrice) {
    return error(shopId, "unit_price_not_found", false, true);
  }

  const currentPrice = parseCountryPrice(unitPrice.value);
  if (!currentPrice) {
    return error(shopId, "do_price_not_found", false, true);
  }

  const originalPriceRaw = attributes.find(
    (attr) => attr.name === "original_price_without_saving"
  );
  const originalPrice = parseCountryPrice(originalPriceRaw?.value);

  return ok(shopId, currentPrice.value, originalPrice?.value ?? null);
}
