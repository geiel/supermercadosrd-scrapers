import { z } from "zod";
import {
  PRICESMART_DISCOVERY_API_URL,
  PRICESMART_PRODUCT_API_URL,
} from "../api-endpoints.js";
import { fetchWithRetry, getPricesmartHeaders } from "../http-client.js";
import { dedupeUrls, isRecord } from "../image-utils.js";
import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";

const shopId = 5;
const shopName = "pricesmart";

const variantSchema = z.object({
  sku: z.string().optional(),
  images: z.array(z.object({ url: z.string() })).nullish(),
  attributesRaw: z.array(z.object({ name: z.string(), value: z.unknown() })).nullish(),
});

const productResponseSchema = z.object({
  data: z.object({
    products: z.object({
      results: z.array(z.object({
        masterData: z.object({
          current: z.object({
            masterVariant: variantSchema.nullish(),
            allVariants: z.array(variantSchema).default([]),
          }),
        }),
      })),
    }),
  }),
});

function localizedImageUrl(image: unknown): string | undefined {
  if (typeof image === "string") return image;
  if (!isRecord(image)) return undefined;

  for (const locale of ["es-DO", "en-DO", "es-CR", "en-CR", "es", "en"]) {
    if (typeof image[locale] === "string" && image[locale].trim()) {
      return image[locale];
    }
  }

  return Object.values(image).find(
    (value): value is string => typeof value === "string" && !!value.trim()
  );
}

export function extractPricesmartProductImages(payload: unknown, sku: string) {
  const parsed = productResponseSchema.safeParse(payload);
  if (!parsed.success) return [];

  const images: Array<string | undefined> = [];
  for (const product of parsed.data.data.products.results) {
    const current = product.masterData.current;
    for (const variant of [current.masterVariant, ...current.allVariants]) {
      // A product can contain several colors or sizes. Only use the linked SKU.
      if (!variant || variant.sku !== sku) continue;

      for (const attribute of variant.attributesRaw ?? []) {
        if (attribute.name !== "localized_images") continue;
        let localized: unknown = attribute.value;
        if (typeof localized === "string") {
          try { localized = JSON.parse(localized); } catch { continue; }
        }
        if (Array.isArray(localized)) {
          images.push(...localized.map(localizedImageUrl));
        }
      }
      images.push(...(variant.images ?? []).map((image) => image.url));
    }
  }

  return dedupeUrls(images).filter((url) => /^https?:\/\//i.test(url));
}

async function fetchProductImages(sku: string, requestConfig?: FetchWithRetryConfig) {
  const response = await fetchWithRetry(
    PRICESMART_PRODUCT_API_URL,
    {
      method: "POST",
      headers: getPricesmartHeaders(),
      body: JSON.stringify([{ skus: [sku] }, { products: "getProductBySKU" }]),
    },
    requestConfig
  );
  if (!response) return [];
  return extractPricesmartProductImages(await response.json().catch(() => null), sku);
}

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

  let pathname = input.url;
  try { pathname = new URL(input.url).pathname; } catch { /* Accept a path too. */ }
  const urlSku = pathname.match(/\/(\d+(?:-\d+)?)\/?$/)?.[1];
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

  const exactMatch = parsed.data.response.docs.find(
    (doc) => doc.master_sku === sku || doc.pid === sku
  );

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
    const gallery = await fetchProductImages(sku, requestConfig);
    if (gallery.length > 0) {
      return { status: "ok", shopId, shopName, images: gallery };
    }
  }

  // Discovery is a thumbnail-only fallback, after trying every exact SKU.
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
