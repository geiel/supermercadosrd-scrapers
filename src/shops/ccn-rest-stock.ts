import { z } from "zod";
import { fetchWithRetryDetailed, getNacionalHeaders } from "../http-client.js";
import { notFound, ok, withStock } from "../result.js";
import type { FetchWithRetryConfig, ScrapePriceResult } from "../types.js";
import { resolveJumboStoreCode } from "./jumbo-shared.js";
import { resolveMercaJumboStoreCode } from "./merca-jumbo-shared.js";
import { isSpecialPriceActive, parsePrice } from "./nacional.js";

// Nacional, Jumbo and Merca Jumbo (the same Magento) leave a product with no
// stock out of GraphQL, while their web page still shows it with its price
// and «Notificarme cuando este producto vuelva a stock» (is_salable empty,
// schema.org OutOfStock). Checked 2026-11-26: 30 of 30 Nacional offers left
// out of GraphQL were out of stock on the web and the 17 listed ones in stock;
// Jumbo's left-out offers were either out of stock on the web or 404.
//
// The REST catalog tells them apart in one request for many SKUs: a product
// still enabled (status 1) on the store's website is out of stock online,
// with the price the web shows; one disabled (status 2) or off the website
// is gone.
export const CCN_STOCK_STORES = {
  2: { websiteId: 1, storeCode: () => "default" },
  3: { websiteId: 51, storeCode: resolveJumboStoreCode },
  7: { websiteId: 59, storeCode: () => resolveMercaJumboStoreCode() ?? "mercajumbo" },
} as const;

export type CcnStockShopId = keyof typeof CCN_STOCK_STORES;

export function isCcnStockShop(shopId: number): shopId is CcnStockShopId {
  return shopId in CCN_STOCK_STORES;
}

const restItemSchema = z.object({
  sku: z.string(),
  status: z.union([z.number(), z.string()]).nullish(),
  price: z.union([z.number(), z.string()]).nullish(),
  extension_attributes: z
    .object({ website_ids: z.array(z.union([z.number(), z.string()])).nullish() })
    .nullish(),
  custom_attributes: z
    .array(z.object({ attribute_code: z.string(), value: z.unknown() }))
    .nullish(),
});

export type CcnRestItem = z.infer<typeof restItemSchema>;

const restResponseSchema = z.object({ items: z.array(z.unknown()).nullish() });

export async function fetchCcnRestProductsBySkus(
  shopId: CcnStockShopId,
  skus: string[],
  requestConfig?: FetchWithRetryConfig
): Promise<{ ok: true; items: Map<string, CcnRestItem> } | { ok: false; reason: string }> {
  const params = new URLSearchParams({
    "searchCriteria[filter_groups][0][filters][0][field]": "sku",
    "searchCriteria[filter_groups][0][filters][0][value]": skus.join(","),
    "searchCriteria[filter_groups][0][filters][0][condition_type]": "in",
    "searchCriteria[pageSize]": String(skus.length),
    fields:
      "items[sku,status,price,extension_attributes[website_ids],custom_attributes[attribute_code,value]],total_count",
  });
  const url = `https://supermercadosnacional.com/rest/${CCN_STOCK_STORES[shopId].storeCode()}/V1/products?${params}`;
  const { response, failureReason } = await fetchWithRetryDetailed(
    url,
    {
      headers: {
        Accept: "application/json",
        Referer: "https://supermercadosnacional.com/",
        "User-Agent": getNacionalHeaders()["User-Agent"],
      },
    },
    requestConfig
  );

  if (!response) return { ok: false, reason: failureReason };
  if (!response.ok) return { ok: false, reason: `http_${response.status}` };

  const parsed = restResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, reason: "invalid_payload" };

  const items = new Map<string, CcnRestItem>();
  for (const raw of parsed.data.items ?? []) {
    const item = restItemSchema.safeParse(raw);
    if (item.success) items.set(item.data.sku, item.data);
  }
  return { ok: true, items };
}

function attribute(item: CcnRestItem, code: string) {
  return item.custom_attributes?.find((entry) => entry.attribute_code === code)?.value;
}

/**
 * A product GraphQL left out: out of stock online when the store still sells
 * it on its website (with the price its page shows), gone otherwise.
 */
export function toCcnLeftOutResult(
  shopId: CcnStockShopId,
  item: CcnRestItem,
  now = new Date()
): ScrapePriceResult {
  const onWebsite = (item.extension_attributes?.website_ids ?? []).some(
    (websiteId) => Number(websiteId) === CCN_STOCK_STORES[shopId].websiteId
  );
  if (Number(item.status) !== 1 || !onWebsite) {
    return notFound(shopId, "product_not_found", true);
  }

  const regularPrice = parsePrice(item.price);
  if (regularPrice === null || regularPrice <= 0) {
    return notFound(shopId, "price_not_found", true);
  }

  const specialPrice = parsePrice(attribute(item, "special_price"));
  const onSale =
    specialPrice !== null &&
    specialPrice > 0 &&
    specialPrice < regularPrice &&
    isSpecialPriceActive(attribute(item, "special_from_date"), attribute(item, "special_to_date"), now);

  return withStock(
    onSale
      ? ok(shopId, specialPrice.toString(), regularPrice.toString())
      : ok(shopId, regularPrice.toString(), null),
    // Merca Jumbo lists its branches: none has it, so the old rows go.
    { outOfStockOnline: true, ...(shopId === 7 ? { locations: [] } : {}) }
  );
}
