import { z } from "zod";
import { fetchWithRetry, getPlazaLamaHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 4;
const endpoint = "https://nextgentheadless.instaleap.io/api/v3";

const query = `query GetProductsBySKU($getProductsBySKUInput: GetProductsBySKUInput!) {
  getProductsBySKU(getProductsBySKUInput: $getProductsBySKUInput) {
    price
    promotion {
      conditions {
        price
      }
    }
  }
}`;

const responseSchema = z.array(
  z.object({
    data: z.object({
      getProductsBySKU: z.array(
        z.object({
          price: z.number(),
          promotion: z
            .object({
              conditions: z.array(
                z.object({
                  price: z.number(),
                })
              ),
            })
            .nullable(),
        })
      ),
    }),
  })
);

export async function scrapePlazaLamaPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  if (!input.api) {
    return error(shopId, "missing_api", false, false);
  }

  const payload = [
    {
      operationName: "GetProductsBySKU",
      variables: {
        getProductsBySKUInput: {
          clientId: "PLAZA_LAMA",
          skus: [input.api],
          storeReference: "PL08-D",
        },
      },
      query,
    },
  ];

  const response = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: getPlazaLamaHeaders(),
    },
    requestConfig
  );

  if (!response) {
    return error(shopId, "request_failed", true, false);
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  if (!jsonResponse) {
    return error(shopId, "invalid_json", true, false);
  }

  const parsed = responseSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, false);
  }

  const products = parsed.data[0]?.data.getProductsBySKU ?? [];
  if (products.length === 0) {
    return notFound(shopId, "product_not_found", true);
  }

  const first = products[0];
  const promoPrice = first.promotion?.conditions[0]?.price ?? first.price;
  return ok(shopId, String(promoPrice), String(first.price));
}
