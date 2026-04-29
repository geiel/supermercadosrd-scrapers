import { z } from "zod";
import { fetchWithRetry, getPlazaLamaHeaders } from "../http-client.js";
import { dedupeUrls } from "../image-utils.js";
import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";

const shopId = 4;
const shopName = "plaza_lama";
const endpoint = "https://nextgentheadless.instaleap.io/api/v3";
const PLAZA_LAMA_SKU_PATTERN = /-([0-9]{8,14})\/?$/i;

const query = `query GetProductsBySKU($getProductsBySKUInput: GetProductsBySKUInput!) {
  getProductsBySKU(getProductsBySKUInput: $getProductsBySKUInput) {
    photosUrl
  }
}`;

const responseSchema = z.array(
  z.object({
    data: z.object({
      getProductsBySKU: z.array(
        z.object({
          photosUrl: z.array(z.string()).default([]),
        })
      ),
    }),
  })
);

function extractPlazaLamaSku(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    return pathname.match(PLAZA_LAMA_SKU_PATTERN)?.[1] ?? null;
  } catch {
    return url.match(PLAZA_LAMA_SKU_PATTERN)?.[1] ?? null;
  }
}

function getPlazaLamaSku(input: ScrapeProductImagesInput): string | null {
  return input.api?.trim() || extractPlazaLamaSku(input.url);
}

export async function scrapePlazaLamaImages(
  input: ScrapeProductImagesInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapeProductImagesResult> {
  const sku = getPlazaLamaSku(input);
  if (!sku) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "missing_api",
      retryable: false,
    };
  }

  const payload = [
    {
      operationName: "GetProductsBySKU",
      variables: {
        getProductsBySKUInput: {
          clientId: "PLAZA_LAMA",
          skus: [sku],
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
    return {
      status: "error",
      shopId,
      shopName,
      reason: "request_failed",
      retryable: true,
    };
  }

  const payloadJson: unknown = await response.json().catch(() => null);
  if (!payloadJson) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "invalid_json",
      retryable: true,
    };
  }

  const parsed = responseSchema.safeParse(payloadJson);
  if (!parsed.success) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "invalid_payload",
      retryable: false,
    };
  }

  const images = dedupeUrls(parsed.data[0]?.data.getProductsBySKU[0]?.photosUrl ?? []);
  if (images.length === 0) {
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
    images,
  };
}
