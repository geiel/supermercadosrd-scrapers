import type {
  ScrapePriceError,
  ScrapePriceNotFound,
  ScrapePriceSuccess,
  ShopId,
  ShopName,
} from "./types.js";

export const SHOP_NAMES: Record<ShopId, ShopName> = {
  1: "sirena",
  2: "nacional",
  3: "jumbo",
  4: "plaza_lama",
  5: "pricesmart",
  6: "bravo",
};

export function ok(
  shopId: ShopId,
  currentPrice: string,
  regularPrice: string | null
): ScrapePriceSuccess {
  return {
    status: "ok",
    shopId,
    shopName: SHOP_NAMES[shopId],
    currentPrice,
    regularPrice,
  };
}

export function notFound(
  shopId: ShopId,
  reason: string,
  hide = true
): ScrapePriceNotFound {
  return {
    status: "not_found",
    shopId,
    shopName: SHOP_NAMES[shopId],
    reason,
    hide,
  };
}

export function error(
  shopId: ShopId,
  reason: string,
  retryable = true,
  hide = false
): ScrapePriceError {
  return {
    status: "error",
    shopId,
    shopName: SHOP_NAMES[shopId],
    reason,
    retryable,
    hide,
  };
}
