import { z } from "zod";
import { PRICESMART_PRODUCT_API_URL } from "../api-endpoints.js";
import { fetchWithRetry, getPricesmartHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import { getPreferredDoPricesmartLocationPrice } from "../pricesmart-locations.js";
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
    club: z.string().optional(),
    value: z.string(),
  })
);

type PricesmartProductResult = z.infer<typeof responseSchema>["data"]["products"]["results"][number];

function parseCountryPrice(raw: unknown) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = countryPriceSchema.safeParse(JSON.parse(String(raw)));
    if (!parsed.success) {
      return null;
    }

    return getPreferredDoPricesmartLocationPrice(parsed.data) ?? null;
  } catch {
    return null;
  }
}

function getPricesmartSkuCandidates(input: ScrapePriceInput) {
  const skuCandidates: string[] = [];

  if (input.api?.trim()) {
    skuCandidates.push(input.api.trim());
  }

  const urlSku = input.url.match(/\/(\d+)\/?$/)?.[1];
  if (urlSku && !skuCandidates.includes(urlSku)) {
    skuCandidates.push(urlSku);
  }

  return skuCandidates;
}

export async function scrapePricesmartPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const skuCandidates = getPricesmartSkuCandidates(input);
  if (skuCandidates.length === 0) {
    return error(shopId, "missing_api", false, true);
  }

  let result: PricesmartProductResult | null = null;

  for (const sku of skuCandidates) {
    const response = await fetchWithRetry(
      PRICESMART_PRODUCT_API_URL,
      {
        method: "POST",
        body: JSON.stringify([
          { skus: [sku] },
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

    const currentResult = parsed.data.data.products.results[0];
    if (currentResult) {
      result = currentResult;
      break;
    }
  }

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

  const regularPrice =
    originalPrice && originalPrice.club === currentPrice.club
      ? originalPrice.value
      : null;

  return ok(shopId, currentPrice.value, regularPrice, currentPrice.club ?? null);
}
