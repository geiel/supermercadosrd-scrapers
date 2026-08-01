import { and, desc, eq } from "drizzle-orm";

import type { db } from "./client.js";
import { productsPricesHistory } from "./schema.js";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PriceValue = string | number | null | undefined;

export type ProductPriceState = {
  price: PriceValue;
  regularPrice: PriceValue;
};

export type ProductPriceHistoryCaptureType =
  | "legacy_price_only"
  | "initial_snapshot"
  | "state_change";

function comparablePrice(value: PriceValue) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function productPriceStatesEqual(
  left: ProductPriceState,
  right: ProductPriceState
) {
  return (
    comparablePrice(left.price) === comparablePrice(right.price) &&
    comparablePrice(left.regularPrice) === comparablePrice(right.regularPrice)
  );
}

export function getProductPriceHistoryCaptureType(
  latest:
    | (ProductPriceState & { captureType: ProductPriceHistoryCaptureType })
    | null
    | undefined,
  current: ProductPriceState
): Exclude<ProductPriceHistoryCaptureType, "legacy_price_only"> | null {
  const latestIsReliable = latest && latest.captureType !== "legacy_price_only";

  if (latestIsReliable && productPriceStatesEqual(latest, current)) {
    return null;
  }

  return latestIsReliable ? "state_change" : "initial_snapshot";
}

export async function recordProductPriceStateInTransaction(
  tx: DbTransaction,
  input: {
    productId: number;
    shopId: number;
    price: string | null;
    regularPrice: string | null;
    createdAt?: Date | null;
  }
) {
  const price = comparablePrice(input.price);
  if (price === null || price <= 0) {
    return false;
  }

  const [latestHistory] = await tx
    .select({
      price: productsPricesHistory.price,
      regularPrice: productsPricesHistory.regularPrice,
      captureType: productsPricesHistory.captureType,
    })
    .from(productsPricesHistory)
    .where(
      and(
        eq(productsPricesHistory.productId, input.productId),
        eq(productsPricesHistory.shopId, input.shopId)
      )
    )
    .orderBy(
      desc(productsPricesHistory.createdAt),
      desc(productsPricesHistory.id)
    )
    .limit(1);

  const currentState = {
    price: input.price,
    regularPrice: input.regularPrice,
  };
  const captureType = getProductPriceHistoryCaptureType(
    latestHistory,
    currentState
  );
  if (captureType === null) {
    return false;
  }

  await tx.insert(productsPricesHistory).values({
    productId: input.productId,
    shopId: input.shopId,
    price: input.price!,
    regularPrice: input.regularPrice,
    captureType,
    createdAt: input.createdAt ?? new Date(),
  });

  return true;
}
