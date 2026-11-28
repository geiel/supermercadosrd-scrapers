import type { PurchaseTerms } from "../purchase-terms.js";
import { locationInStock } from "../result.js";
import type {
  ScrapeLocationAvailability,
  ScrapePriceResult,
  ScrapePriceSuccess,
} from "../types.js";
import { productPriceStatesEqual } from "./product-price-history.js";
import type { ProductShopPriceRow } from "./schema.js";

export type ShopPriceRow = Pick<
  ProductShopPriceRow,
  | "productId"
  | "shopId"
  | "url"
  | "api"
  | "locationId"
  | "currentPrice"
  | "regularPrice"
  | "purchaseMode"
  | "purchaseUnit"
  | "minimumPurchaseQuantity"
  | "purchaseQuantityIncrement"
  | "maximumPurchaseQuantity"
  | "priceReferenceQuantity"
  | "purchaseTermsSource"
  | "updateAt"
  | "hidden"
> & {
  outOfStockOnline?: boolean | null;
  presentation?: string | null;
};

export type OfferKey = { productId: number; shopId: number };
export type BranchRef = { id: number; active: boolean };

export type OfferLocationValue = {
  productId: number;
  shopId: number;
  locationId: number;
  available: boolean;
  stock: string | null;
  currentPrice: string | null;
  regularPrice: string | null;
  observedAt: Date;
};

export type ExistingOfferLocationRow = {
  locationId: number;
  available: boolean;
  stock: string | null;
  currentPrice: string | null;
  regularPrice: string | null;
};

export function sameNumber(
  left: string | number | null,
  right: string | number | null
) {
  if (left === null || right === null) {
    return left === right;
  }
  return Number(left) === Number(right);
}

/**
 * With branches, out of stock online is decided by the active ones only:
 * a closed branch's stock is no use to anyone (the page leaves it out too).
 * A store listing only closed branches has it nowhere one can buy.
 */
export function resolveEffectiveOutOfStockOnline(
  byCode: Map<string, ScrapeLocationAvailability>,
  ids: Map<string, BranchRef> | null,
  fallbackOutOfStockOnline: boolean | null | undefined
): boolean | null | undefined {
  if (!ids || byCode.size === 0) {
    return fallbackOutOfStockOnline;
  }

  const active = [...byCode.values()].filter(
    (location) => ids.get(location.externalId)?.active
  );
  return !active.some(locationInStock);
}

export function buildOfferLocationValues(
  offer: OfferKey,
  byCode: Map<string, ScrapeLocationAvailability>,
  ids: Map<string, BranchRef>,
  observedAt: Date
): OfferLocationValue[] {
  return [...byCode.values()].flatMap((location) => {
    const locationId = ids.get(location.externalId)?.id;
    return locationId === undefined
      ? []
      : [
          {
            productId: offer.productId,
            shopId: offer.shopId,
            locationId,
            available: location.available,
            stock: location.stock === null ? null : String(location.stock),
            currentPrice: location.currentPrice,
            regularPrice: location.regularPrice,
            observedAt,
          },
        ];
  });
}

export function diffOfferLocations(
  existing: readonly ExistingOfferLocationRow[],
  values: readonly OfferLocationValue[]
): { changed: boolean; staleLocationIds: number[] } {
  const before = new Map(existing.map((row) => [row.locationId, row]));
  const keepSet = new Set(values.map((value) => value.locationId));
  const staleLocationIds = existing
    .filter((row) => !keepSet.has(row.locationId))
    .map((row) => row.locationId);

  const changed =
    staleLocationIds.length > 0 ||
    values.some((value) => {
      const row = before.get(value.locationId);
      return (
        !row ||
        row.available !== value.available ||
        !sameNumber(row.stock, value.stock) ||
        !sameNumber(row.currentPrice, value.currentPrice) ||
        !sameNumber(row.regularPrice, value.regularPrice)
      );
    });

  return { changed, staleLocationIds };
}

export function purchaseTermsPatch(
  purchaseTerms: PurchaseTerms | null,
  observedAt: Date = new Date()
) {
  if (purchaseTerms === null) {
    return {
      purchaseMode: null,
      purchaseUnit: null,
      minimumPurchaseQuantity: null,
      purchaseQuantityIncrement: null,
      maximumPurchaseQuantity: null,
      priceReferenceQuantity: null,
      purchaseTermsSource: null,
      purchaseTermsEvidence: null,
      purchaseTermsObservedAt: observedAt,
    };
  }

  return {
    purchaseMode: purchaseTerms.mode,
    purchaseUnit: purchaseTerms.unit,
    minimumPurchaseQuantity: purchaseTerms.minimum,
    purchaseQuantityIncrement: purchaseTerms.increment,
    maximumPurchaseQuantity: purchaseTerms.maximum,
    priceReferenceQuantity: purchaseTerms.priceReferenceQuantity,
    purchaseTermsSource: purchaseTerms.source,
    purchaseTermsEvidence: purchaseTerms.evidence,
    purchaseTermsObservedAt: observedAt,
  };
}

export function purchaseTermsChanged(
  row: ShopPriceRow,
  purchaseTerms: PurchaseTerms | null | undefined
) {
  if (purchaseTerms === undefined) {
    return false;
  }

  const expected = purchaseTermsPatch(purchaseTerms);
  return (
    (row.purchaseMode ?? null) !== expected.purchaseMode ||
    (row.purchaseUnit ?? null) !== expected.purchaseUnit ||
    Number(row.minimumPurchaseQuantity ?? 0) !==
      Number(expected.minimumPurchaseQuantity ?? 0) ||
    Number(row.purchaseQuantityIncrement ?? 0) !==
      Number(expected.purchaseQuantityIncrement ?? 0) ||
    Number(row.maximumPurchaseQuantity ?? 0) !==
      Number(expected.maximumPurchaseQuantity ?? 0) ||
    Number(row.priceReferenceQuantity ?? 0) !==
      Number(expected.priceReferenceQuantity ?? 0) ||
    (row.purchaseTermsSource ?? null) !== expected.purchaseTermsSource
  );
}

export function normalizeUrlForComparison(url: string) {
  return url.trim().replace(/\/+$/, "");
}

export function isPriceRowUnchanged(
  row: ShopPriceRow,
  result: ScrapePriceSuccess
) {
  const canonicalUrl = result.canonicalUrl?.trim() || null;
  const urlChanged =
    canonicalUrl !== null &&
    normalizeUrlForComparison(row.url) !==
      normalizeUrlForComparison(canonicalUrl);
  const termsChanged = purchaseTermsChanged(row, result.purchaseTerms);
  const priceAndLocationUnchanged =
    row.currentPrice !== null &&
    productPriceStatesEqual(
      { price: row.currentPrice, regularPrice: row.regularPrice },
      { price: result.currentPrice, regularPrice: result.regularPrice }
    ) &&
    (row.locationId ?? null) === (result.locationId ?? null);

  return priceAndLocationUnchanged && !urlChanged && !termsChanged;
}

export type ScrapeWriteClassification =
  | {
      kind: "batch_touch";
      hasPurchaseTerms: boolean;
      expectedOutOfStockOnline: boolean | null | undefined;
    }
  | {
      kind: "batch_locations";
      canBatchTouchAfterStock: boolean;
      hasPurchaseTerms: boolean;
    }
  | { kind: "individual" };

/**
 * Decides whether a scrape result can share a batched DB write or needs the
 * full per-row applyScrapeResult flow.
 */
export function classifyScrapeWrite(
  row: ShopPriceRow,
  result: ScrapePriceResult
): ScrapeWriteClassification {
  if (result.status !== "ok" || result.productMeasurementUpdate) {
    return { kind: "individual" };
  }

  const unchangedPriceRow = isPriceRowUnchanged(row, result);
  const hasPurchaseTerms = result.purchaseTerms !== undefined;

  if (result.locations !== undefined) {
    return {
      kind: "batch_locations",
      canBatchTouchAfterStock: !row.hidden && unchangedPriceRow,
      hasPurchaseTerms,
    };
  }

  if (row.hidden || !unchangedPriceRow) {
    return { kind: "individual" };
  }

  // Only batch-touch when outOfStockOnline is either omitted by the store or
  // already matches what we loaded (and the batch UPDATE double-checks it in SQL).
  if (
    result.outOfStockOnline !== undefined &&
    (row.outOfStockOnline === undefined ||
      row.outOfStockOnline !== result.outOfStockOnline)
  ) {
    return { kind: "individual" };
  }

  return {
    kind: "batch_touch",
    hasPurchaseTerms,
    expectedOutOfStockOnline: result.outOfStockOnline,
  };
}

/**
 * Separates entries whose (shopId, productId) appears more than once so a
 * batch upsert/update never hits the same offer twice in one statement.
 */
export function partitionUniqueBatchEntries<T extends readonly [ShopPriceRow, ScrapePriceResult]>(
  entries: readonly T[]
): { unique: T[]; duplicates: T[] } {
  const counts = new Map<string, number>();
  for (const [row] of entries) {
    const key = `${row.shopId}:${row.productId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const unique: T[] = [];
  const duplicates: T[] = [];
  for (const entry of entries) {
    const key = `${entry[0].shopId}:${entry[0].productId}`;
    if ((counts.get(key) ?? 0) > 1) {
      duplicates.push(entry);
    } else {
      unique.push(entry);
    }
  }

  return { unique, duplicates };
}
