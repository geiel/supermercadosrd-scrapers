import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  productsShopsLocations,
  productsShopsPrices,
  shopLocations,
} from "./schema.js";
import type { ScrapeLocationAvailability, ScrapePriceSuccess } from "../types.js";

type OfferKey = { productId: number; shopId: number };

// shopId -> the store's branch code -> shop_locations.id, loaded once per run.
const locationIdsByShop = new Map<number, Map<string, number>>();

async function loadLocationIds(shopId: number) {
  const rows = await db
    .select({ id: shopLocations.id, externalId: shopLocations.externalId })
    .from(shopLocations)
    .where(eq(shopLocations.shopId, shopId));
  const ids = new Map(rows.map((row) => [row.externalId, row.id]));
  locationIdsByShop.set(shopId, ids);
  return ids;
}

/** Branch ids for these codes; a branch the store just opened is added under its code. */
async function resolveLocationIds(shopId: number, externalIds: string[]) {
  let ids = locationIdsByShop.get(shopId) ?? (await loadLocationIds(shopId));
  const missing = externalIds.filter((externalId) => !ids.has(externalId));
  if (missing.length === 0) {
    return ids;
  }

  await db
    .insert(shopLocations)
    .values(missing.map((externalId) => ({ shopId, externalId, name: externalId })))
    .onConflictDoNothing();
  console.warn(
    `[LOCATIONS] shopId=${shopId} new branch codes ${missing.join(",")}: added with the code as name`
  );
  ids = await loadLocationIds(shopId);
  return ids;
}

function sameNumber(left: string | number | null, right: string | number | null) {
  if (left === null || right === null) {
    return left === right;
  }
  return Number(left) === Number(right);
}

/**
 * Replaces the offer's branch rows with what the store says now: upserts the
 * listed branches and deletes the ones it no longer lists. Returns whether
 * anything a reader sees changed (availability, stock or a price).
 */
export async function syncOfferLocations(
  offer: OfferKey,
  locations: ScrapeLocationAvailability[]
): Promise<boolean> {
  const byCode = new Map(locations.map((location) => [location.externalId, location]));
  const ids = await resolveLocationIds(offer.shopId, [...byCode.keys()]);
  const observedAt = new Date();
  const values = [...byCode.values()].flatMap((location) => {
    const locationId = ids.get(location.externalId);
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

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(productsShopsLocations)
      .where(
        and(
          eq(productsShopsLocations.productId, offer.productId),
          eq(productsShopsLocations.shopId, offer.shopId)
        )
      );
    const before = new Map(existing.map((row) => [row.locationId, row]));
    const keep = values.map((value) => value.locationId);
    const changed =
      existing.some((row) => !keep.includes(row.locationId)) ||
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

    if (values.length > 0) {
      await tx
        .insert(productsShopsLocations)
        .values(values)
        .onConflictDoUpdate({
          target: [productsShopsLocations.productId, productsShopsLocations.locationId],
          set: {
            available: sql`excluded."available"`,
            stock: sql`excluded."stock"`,
            currentPrice: sql`excluded."currentPrice"`,
            regularPrice: sql`excluded."regularPrice"`,
            observedAt: sql`excluded."observedAt"`,
          },
        });
    }

    await tx
      .delete(productsShopsLocations)
      .where(
        and(
          eq(productsShopsLocations.productId, offer.productId),
          eq(productsShopsLocations.shopId, offer.shopId),
          ...(keep.length > 0 ? [notInArray(productsShopsLocations.locationId, keep)] : [])
        )
      );

    return changed;
  });
}

/**
 * Writes the result's stock signals: the offer's «agotado online» (left alone
 * when the result does not say) and its branch rows. Returns whether the
 * product page needs a refresh. A failure is logged, never thrown, so the
 * price that was just saved stands.
 */
export async function applyStockSignals(
  offer: OfferKey,
  result: Pick<ScrapePriceSuccess, "outOfStockOnline" | "locations" | "shopName">
): Promise<boolean> {
  let changed = false;

  try {
    if (result.outOfStockOnline !== undefined) {
      const updated = await db
        .update(productsShopsPrices)
        .set({ outOfStockOnline: result.outOfStockOnline })
        .where(
          and(
            eq(productsShopsPrices.productId, offer.productId),
            eq(productsShopsPrices.shopId, offer.shopId),
            sql`${productsShopsPrices.outOfStockOnline} IS DISTINCT FROM ${result.outOfStockOnline}::boolean`
          )
        )
        .returning({ productId: productsShopsPrices.productId });
      changed = updated.length > 0;
    }

    if (result.locations !== undefined) {
      changed = (await syncOfferLocations(offer, result.locations)) || changed;
    }
  } catch (error) {
    console.error(
      `[STOCK] ${result.shopName} productId=${offer.productId} shopId=${offer.shopId} failed`,
      error
    );
  }

  return changed;
}

/** For tests and one-off scripts that switch databases. */
export function resetLocationIdCache() {
  locationIdsByShop.clear();
}
