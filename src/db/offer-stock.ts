import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  productsShopsLocations,
  productsShopsPrices,
  shopLocations,
} from "./schema.js";
import type { ScrapeLocationAvailability, ScrapePriceSuccess } from "../types.js";
import { locationInStock } from "../result.js";

type OfferKey = { productId: number; shopId: number };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type BranchRef = { id: number; active: boolean };

// shopId -> the store's branch code -> its shop_locations row, loaded once per run.
const locationIdsByShop = new Map<number, Map<string, BranchRef>>();

async function loadLocationIds(shopId: number) {
  const rows = await db
    .select({ id: shopLocations.id, externalId: shopLocations.externalId, active: shopLocations.active })
    .from(shopLocations)
    .where(eq(shopLocations.shopId, shopId));
  const ids = new Map(rows.map((row) => [row.externalId, { id: row.id, active: row.active }]));
  locationIdsByShop.set(shopId, ids);
  return ids;
}

/** Branch ids for these codes; a branch the store just opened is added under its code. */
async function resolveLocationIds(shopId: number, externalIds: string[]): Promise<Map<string, BranchRef>> {
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
async function syncOfferLocations(
  tx: Tx,
  offer: OfferKey,
  byCode: Map<string, ScrapeLocationAvailability>,
  ids: Map<string, BranchRef>
): Promise<boolean> {
  const observedAt = new Date();
  const values = [...byCode.values()].flatMap((location) => {
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
  if (result.outOfStockOnline === undefined && result.locations === undefined) {
    return false;
  }

  try {
    const byCode = new Map((result.locations ?? []).map((location) => [location.externalId, location]));
    const ids = result.locations === undefined ? null : await resolveLocationIds(offer.shopId, [...byCode.keys()]);

    // With branches, out of stock online is decided by the active ones only:
    // a closed branch's stock is no use to anyone (the page leaves it out too).
    const active = ids ? [...byCode.values()].filter((location) => ids.get(location.externalId)?.active) : [];
    const outOfStockOnline =
      active.length > 0 ? !active.some(locationInStock) : result.outOfStockOnline;

    // The flag and its branch rows change together or not at all.
    return await db.transaction(async (tx) => {
      let changed = false;
      if (outOfStockOnline !== undefined) {
        const updated = await tx
          .update(productsShopsPrices)
          .set({ outOfStockOnline })
          .where(
            and(
              eq(productsShopsPrices.productId, offer.productId),
              eq(productsShopsPrices.shopId, offer.shopId),
              sql`${productsShopsPrices.outOfStockOnline} IS DISTINCT FROM ${outOfStockOnline}::boolean`
            )
          )
          .returning({ productId: productsShopsPrices.productId });
        changed = updated.length > 0;
      }

      if (ids) {
        changed = (await syncOfferLocations(tx, offer, byCode, ids)) || changed;
      }
      return changed;
    });
  } catch (error) {
    console.error(
      `[STOCK] ${result.shopName} productId=${offer.productId} shopId=${offer.shopId} failed`,
      error
    );
    return false;
  }
}

/** For tests and one-off scripts that switch databases. */
export function resetLocationIdCache() {
  locationIdsByShop.clear();
}
