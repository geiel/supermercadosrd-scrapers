import { z } from "zod";
import { PRICESMART_DISCOVERY_API_URL } from "../api-endpoints.js";
import { fetchWithRetry } from "../http-client.js";
import { dedupeUrls, extractTrailingNumericId } from "../image-utils.js";
import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";

const shopId = 5;
const shopName = "pricesmart";

const searchHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/json",
};

const responseSchema = z.object({
  response: z.object({
    docs: z.array(
      z.object({
        pid: z.string().optional(),
        master_sku: z.string().optional(),
        thumb_image: z.string().optional(),
        variants: z
          .array(
            z.object({
              skuid: z.string().optional(),
            })
          )
          .default([]),
      })
    ),
  }),
});

function getSkuCandidates(input: ScrapeProductImagesInput) {
  const skuCandidates: string[] = [];

  const apiSku = input.api?.trim();
  if (apiSku) {
    skuCandidates.push(apiSku);
  }

  const urlSku = extractTrailingNumericId(input.url);
  if (urlSku && !skuCandidates.includes(urlSku)) {
    skuCandidates.push(urlSku);
  }

  return skuCandidates;
}

async function searchBySku(
  sku: string,
  requestConfig?: FetchWithRetryConfig
) {
  const payload = [
    {
      url: "https://www.pricesmart.com/es-do",
      start: 0,
      q: sku,
      fq: [],
      search_type: "keyword",
      rows: 10,
      account_id: "7024",
      auth_key: "ev7libhybjg5h1d1",
      request_id: Date.now(),
      domain_key: "pricesmart_bloomreach_io_es",
      fl: "pid,title,price,thumb_image,brand,slug,skuid,currency,fractionDigits,master_sku",
      view_id: "DO",
    },
  ];

  const response = await fetchWithRetry(
    PRICESMART_DISCOVERY_API_URL,
    {
      method: "POST",
      headers: searchHeaders,
      body: JSON.stringify(payload),
    },
    requestConfig
  );

  if (!response) {
    return null;
  }

  const payloadJson: unknown = await response.json().catch(() => null);
  if (!payloadJson) {
    return null;
  }

  const parsed = responseSchema.safeParse(payloadJson);
  if (!parsed.success) {
    return null;
  }

  const exactMatch =
    parsed.data.response.docs.find(
      (doc) =>
        doc.master_sku === sku ||
        doc.pid === sku ||
        doc.variants.some((variant) => variant.skuid === sku)
    ) ?? parsed.data.response.docs[0];

  return exactMatch ?? null;
}

export async function scrapePricesmartImages(
  input: ScrapeProductImagesInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapeProductImagesResult> {
  const skuCandidates = getSkuCandidates(input);
  if (skuCandidates.length === 0) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "missing_api",
      retryable: false,
    };
  }

  for (const sku of skuCandidates) {
    const match = await searchBySku(sku, requestConfig);
    if (!match) {
      continue;
    }

    const images = dedupeUrls([match.thumb_image]);
    if (images.length === 0) {
      continue;
    }

    return {
      status: "ok",
      shopId,
      shopName,
      images,
    };
  }

  return {
    status: "not_found",
    shopId,
    shopName,
    reason: "image_not_found",
  };
}
