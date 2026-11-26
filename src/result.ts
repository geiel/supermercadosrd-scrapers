import type {
  ScrapeLocationAvailability,
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
  7: "merca_jumbo",
  8: "garrido",
  10: "carrefour",
  14: "supermix",
  15: "ole",
};

export function ok(
  shopId: ShopId,
  currentPrice: string,
  regularPrice: string | null,
  locationId: string | null = null,
  canonicalUrl?: string | null,
  productMeasurementUpdate?: ScrapePriceSuccess["productMeasurementUpdate"],
  purchaseTerms?: ScrapePriceSuccess["purchaseTerms"]
): ScrapePriceSuccess {
  return {
    status: "ok",
    shopId,
    shopName: SHOP_NAMES[shopId],
    currentPrice,
    regularPrice,
    locationId,
    canonicalUrl: canonicalUrl ?? undefined,
    productMeasurementUpdate,
    ...(purchaseTerms !== undefined ? { purchaseTerms } : {}),
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

/** Adds the stock signals to an ok result (other results pass through). */
export function withStock<T extends ScrapePriceSuccess | ScrapePriceNotFound | ScrapePriceError>(
  result: T,
  stock: Pick<ScrapePriceSuccess, "outOfStockOnline" | "locations">
): T {
  if (result.status !== "ok") {
    return result;
  }

  return {
    ...result,
    outOfStockOnline: stock.outOfStockOnline,
    ...(stock.locations !== undefined ? { locations: stock.locations } : {}),
  } as T;
}

/** In stock at a branch: the store says available and, when it gives a count, units are left. */
export function locationInStock(location: ScrapeLocationAvailability) {
  return location.available && (location.stock === null || location.stock > 0);
}
