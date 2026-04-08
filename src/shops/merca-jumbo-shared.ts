import { z } from "zod";
import { dedupeComparableUrls, normalizeNacionalImageUrl } from "../image-utils.js";
import { fetchWithRetry } from "../http-client.js";
import type { FetchWithRetryConfig } from "../types.js";

const MERCA_JUMBO_API_URL_ENV = "MERCA_JUMBO_API_URL";
const MERCA_JUMBO_STORE_CODE_ENV = "MERCA_JUMBO_STORE_CODE";

const mercaJumboProductQuery = `query MercaJumboProductBySku($sku: String!) {
  products(filter: { sku: { eq: $sku } }) {
    items {
      sku
      name
      url_key
      image {
        url
      }
      small_image {
        url
      }
      price_range {
        minimum_price {
          final_price {
            value
          }
          regular_price {
            value
          }
        }
      }
    }
  }
}`;

const mercaJumboProductResponseSchema = z.object({
  data: z.object({
    products: z.object({
      items: z
        .array(
          z.object({
            sku: z.string(),
            name: z.string().nullable().optional(),
            url_key: z.string().nullable().optional(),
            image: z
              .object({
                url: z.string().nullable().optional(),
              })
              .nullable()
              .optional(),
            small_image: z
              .object({
                url: z.string().nullable().optional(),
              })
              .nullable()
              .optional(),
            price_range: z
              .object({
                minimum_price: z.object({
                  final_price: z.object({
                    value: z.number().nullable().optional(),
                  }),
                  regular_price: z.object({
                    value: z.number().nullable().optional(),
                  }),
                }),
              })
              .nullable()
              .optional(),
          })
        )
        .default([]),
    }),
  }),
});

type MercaJumboProduct = {
  sku: string;
  name: string | null;
  urlKey: string | null;
  imageUrls: string[];
  finalPrice: string | null;
  regularPrice: string | null;
};

export type MercaJumboProductLookupResult =
  | {
      status: "ok";
      product: MercaJumboProduct;
    }
  | {
      status: "error";
      reason:
        | "invalid_url"
        | "missing_api"
        | "missing_store_code"
        | "request_failed"
        | "invalid_payload"
        | `http_${number}`;
      retryable: boolean;
    }
  | {
      status: "not_found";
      reason: "product_not_found";
    };

function normalizeEnvValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function resolveMercaJumboApiUrl(api: string | null | undefined) {
  return normalizeEnvValue(api ?? undefined) ?? normalizeEnvValue(process.env[MERCA_JUMBO_API_URL_ENV]);
}

function resolveMercaJumboStoreCode() {
  return normalizeEnvValue(process.env[MERCA_JUMBO_STORE_CODE_ENV]);
}

export function extractMercaJumboSkuFromUrl(url: string) {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return "";
  }

  try {
    const pathname = new URL(normalizedUrl).pathname.replace(/\/+$/, "");
    const lastSegment = pathname.split("/").pop() ?? "";
    const match = lastSegment.match(/(\d+)$/);
    return match?.[1] ?? "";
  } catch {
    const match = normalizedUrl.replace(/[?#].*$/, "").match(/(\d+)(?:\/)?$/);
    return match?.[1] ?? "";
  }
}

function toPriceString(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value)
    ? null
    : String(value);
}

export async function fetchMercaJumboProductBySku(
  input: {
    sku: string;
    api: string | null | undefined;
  },
  requestConfig?: FetchWithRetryConfig
): Promise<MercaJumboProductLookupResult> {
  if (!input.sku.trim()) {
    return {
      status: "error",
      reason: "invalid_url",
      retryable: false,
    };
  }

  const apiUrl = resolveMercaJumboApiUrl(input.api);
  if (!apiUrl) {
    return {
      status: "error",
      reason: "missing_api",
      retryable: false,
    };
  }

  const storeCode = resolveMercaJumboStoreCode();
  if (!storeCode) {
    return {
      status: "error",
      reason: "missing_store_code",
      retryable: false,
    };
  }

  const response = await fetchWithRetry(
    apiUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        store: storeCode,
      },
      body: JSON.stringify({
        query: mercaJumboProductQuery,
        variables: {
          sku: input.sku,
        },
      }),
    },
    requestConfig
  );

  if (!response) {
    return {
      status: "error",
      reason: "request_failed",
      retryable: true,
    };
  }

  if (!response.ok) {
    return {
      status: "error",
      reason: `http_${response.status}`,
      retryable: response.status >= 500 || response.status === 429,
    };
  }

  const parsedResponse = mercaJumboProductResponseSchema.safeParse(
    await response.json().catch(() => null)
  );

  if (!parsedResponse.success) {
    return {
      status: "error",
      reason: "invalid_payload",
      retryable: false,
    };
  }

  const product =
    parsedResponse.data.data.products.items.find(
      (candidate) => candidate.sku === input.sku
    ) ?? null;

  if (!product) {
    return {
      status: "not_found",
      reason: "product_not_found",
    };
  }

  return {
    status: "ok",
    product: {
      sku: product.sku,
      name: product.name ?? null,
      urlKey: product.url_key ?? null,
      imageUrls: dedupeComparableUrls([
        product.image?.url,
        product.small_image?.url,
      ]).map(normalizeNacionalImageUrl),
      finalPrice: toPriceString(
        product.price_range?.minimum_price.final_price.value ?? null
      ),
      regularPrice: toPriceString(
        product.price_range?.minimum_price.regular_price.value ?? null
      ),
    },
  };
}
