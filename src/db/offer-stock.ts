import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  productsShopsLocations,
  productsShopsPrices,
  shopLocations,
} from "./schema.js";
import {
  buildOfferLocationValues,
  diffOfferLocations,
  resolveEffectiveOutOfStockOnline,
  type BranchRef,
  type OfferKey,
  type OfferLocationValue,
} from "./scrape-write-plan.js";
import type { ScrapeLocationAvailability, ScrapePriceSuccess } from "../types.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type StockSignalResult = Pick<
  ScrapePriceSuccess,
  "outOfStockOnline" | "locations" | "shopName"
>;

export type StockSignalOffer = OfferKey & { url: string; api: string | null };

const STOCK_BATCH_SIZE = 100;
const LOCATION_UPSERT_CHUNK_SIZE = 1500;
const LOCATION_DELETE_CHUNK_SIZE = 500;

// shopId -> the store's branch code -> its shop_locations row, loaded once per run.
const locationIdsByShop = new Map<number, Map<string, BranchRef>>();

async function loadLocationIds(shopId: number) {
  const rows = await db
    .select({
      id: shopLocations.id,
      externalId: shopLocations.externalId,
      active: shopLocations.active,
    })
    .from(shopLocations)
    .where(eq(shopLocations.shopId, shopId));
  const ids = new Map(
    rows.map((row) => [row.externalId, { id: row.id, active: row.active }])
  );
  locationIdsByShop.set(shopId, ids);
  return ids;
}

/** Branch ids for these codes; a branch the store just opened is added under its code. */
async function resolveLocationIds(
  shopId: number,
  externalIds: string[]
): Promise<Map<string, BranchRef>> {
  let ids = locationIdsByShop.get(shopId) ?? (await loadLocationIds(shopId));
  const missing = [...new Set(externalIds)].filter(
    (externalId) => !ids.has(externalId)
  );
  if (missing.length === 0) {
    return ids;
  }

  await db
    .insert(shopLocations)
    .values(
      missing.map((externalId) => ({ shopId, externalId, name: externalId }))
    )
    .onConflictDoNothing();
  console.warn(
    `[LOCATIONS] shopId=${shopId} new branch codes ${missing.join(",")}: added with the code as name`
  );
  ids = await loadLocationIds(shopId);
  return ids;
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
  const values = buildOfferLocationValues(offer, byCode, ids, observedAt);

  const existing = await tx
    .select()
    .from(productsShopsLocations)
    .where(
      and(
        eq(productsShopsLocations.productId, offer.productId),
        eq(productsShopsLocations.shopId, offer.shopId)
      )
    );

  const { changed, staleLocationIds } = diffOfferLocations(existing, values);

  if (values.length > 0) {
    await tx
      .insert(productsShopsLocations)
      .values(values)
      .onConflictDoUpdate({
        target: [
          productsShopsLocations.productId,
          productsShopsLocations.locationId,
        ],
        set: {
          available: sql`excluded."available"`,
          stock: sql`excluded."stock"`,
          currentPrice: sql`excluded."currentPrice"`,
          regularPrice: sql`excluded."regularPrice"`,
          observedAt: sql`excluded."observedAt"`,
        },
      });
  }

  if (staleLocationIds.length > 0) {
    await tx
      .delete(productsShopsLocations)
      .where(
        and(
          eq(productsShopsLocations.productId, offer.productId),
          eq(productsShopsLocations.shopId, offer.shopId),
          inArray(productsShopsLocations.locationId, staleLocationIds)
        )
      );
  }

  return changed;
}

/**
 * Writes the result's stock signals: the offer's «agotado online» (left alone
 * when the result does not say) and its branch rows. Returns whether the
 * product page needs a refresh. A failure is logged, never thrown, so the
 * price that was just saved stands.
 */
export async function applyStockSignals(
  offer: StockSignalOffer,
  result: StockSignalResult
): Promise<boolean> {
  if (result.outOfStockOnline === undefined && result.locations === undefined) {
    return false;
  }

  try {
    const byCode = new Map(
      (result.locations ?? []).map((location) => [location.externalId, location])
    );
    const ids =
      result.locations === undefined
        ? null
        : await resolveLocationIds(offer.shopId, [...byCode.keys()]);

    const outOfStockOnline = resolveEffectiveOutOfStockOnline(
      byCode,
      ids,
      result.outOfStockOnline
    );

    // The flag and its branch rows change together or not at all, and only
    // while the offer still points at the item this result read: an admin
    // may have moved it to another one meanwhile.
    return await db.transaction(async (tx) => {
      const current = await tx.execute(
        sql`select 1 from products_shops_prices
            where "productId" = ${offer.productId} and "shopId" = ${offer.shopId}
              and url = ${offer.url} and api is not distinct from ${offer.api}
            for update`
      );
      if (current.length === 0) return false;

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

/**
 * Applies branch stock signals and «agotado online» for a batch of unique
 * offers from the same shop in a single transaction per chunk. Preserves the
 * per-offer (url, api) lock check and exact change detection while cutting
 * Postgres roundtrips by ~100x on multi-branch stores like Merca Jumbo.
 */
export async function applyStockSignalsBatch(
  shopId: number,
  items: ReadonlyArray<{ offer: StockSignalOffer; result: StockSignalResult }>
): Promise<{ ok: true; changedProductIds: Set<number> } | { ok: false }> {
  if (items.length === 0) {
    return { ok: true, changedProductIds: new Set() };
  }

  const changedProductIds = new Set<number>();

  try {
    const allExternalIds: string[] = [];
    for (const { result } of items) {
      for (const location of result.locations ?? []) {
        allExternalIds.push(location.externalId);
      }
    }
    const ids = await resolveLocationIds(shopId, allExternalIds);

    for (let offset = 0; offset < items.length; offset += STOCK_BATCH_SIZE) {
      const chunk = items.slice(offset, offset + STOCK_BATCH_SIZE);
      const observedAt = new Date();
      const prepared = chunk.map(({ offer, result }) => {
        const byCode = new Map(
          (result.locations ?? []).map((location) => [
            location.externalId,
            location,
          ])
        );
        return {
          offer,
          outOfStockOnline: resolveEffectiveOutOfStockOnline(
            byCode,
            ids,
            result.outOfStockOnline
          ),
          values: buildOfferLocationValues(offer, byCode, ids, observedAt),
        };
      });

      const productIds = prepared.map((item) => item.offer.productId);

      await db.transaction(async (tx) => {
        const lockedRows = await tx
          .select({
            productId: productsShopsPrices.productId,
            url: productsShopsPrices.url,
            api: productsShopsPrices.api,
            outOfStockOnline: productsShopsPrices.outOfStockOnline,
          })
          .from(productsShopsPrices)
          .where(
            and(
              eq(productsShopsPrices.shopId, shopId),
              inArray(productsShopsPrices.productId, productIds)
            )
          )
          .orderBy(asc(productsShopsPrices.productId))
          .for("update");

        const lockedByProductId = new Map(
          lockedRows.map((row) => [row.productId, row])
        );

        const valid = prepared.filter((item) => {
          const locked = lockedByProductId.get(item.offer.productId);
          return (
            locked !== undefined &&
            locked.url === item.offer.url &&
            (locked.api ?? null) === (item.offer.api ?? null)
          );
        });
        if (valid.length === 0) {
          return;
        }

        const validProductIds = valid.map((item) => item.offer.productId);
        const existingRows = await tx
          .select()
          .from(productsShopsLocations)
          .where(
            and(
              eq(productsShopsLocations.shopId, shopId),
              inArray(productsShopsLocations.productId, validProductIds)
            )
          );

        const existingByProductId = new Map<number, typeof existingRows>();
        for (const row of existingRows) {
          const list = existingByProductId.get(row.productId);
          if (list) {
            list.push(row);
          } else {
            existingByProductId.set(row.productId, [row]);
          }
        }

        const oosBuckets = new Map<boolean | null, number[]>([
          [true, []],
          [false, []],
          [null, []],
        ]);
        const allUpserts: OfferLocationValue[] = [];
        const stalePairs: Array<{ productId: number; locationId: number }> = [];

        for (const item of valid) {
          const locked = lockedByProductId.get(item.offer.productId)!;
          if (
            item.outOfStockOnline !== undefined &&
            locked.outOfStockOnline !== item.outOfStockOnline
          ) {
            oosBuckets.get(item.outOfStockOnline)!.push(item.offer.productId);
            changedProductIds.add(item.offer.productId);
          }

          const existing = existingByProductId.get(item.offer.productId) ?? [];
          const { changed, staleLocationIds } = diffOfferLocations(
            existing,
            item.values
          );
          if (changed) {
            changedProductIds.add(item.offer.productId);
          }
          allUpserts.push(...item.values);
          for (const locationId of staleLocationIds) {
            stalePairs.push({ productId: item.offer.productId, locationId });
          }
        }

        for (const [value, idsToUpdate] of oosBuckets) {
          if (idsToUpdate.length === 0) {
            continue;
          }
          await tx
            .update(productsShopsPrices)
            .set({ outOfStockOnline: value })
            .where(
              and(
                eq(productsShopsPrices.shopId, shopId),
                inArray(productsShopsPrices.productId, idsToUpdate),
                sql`${productsShopsPrices.outOfStockOnline} IS DISTINCT FROM ${value}::boolean`
              )
            );
        }

        for (let i = 0; i < allUpserts.length; i += LOCATION_UPSERT_CHUNK_SIZE) {
          await tx
            .insert(productsShopsLocations)
            .values(allUpserts.slice(i, i + LOCATION_UPSERT_CHUNK_SIZE))
            .onConflictDoUpdate({
              target: [
                productsShopsLocations.productId,
                productsShopsLocations.locationId,
              ],
              set: {
                available: sql`excluded."available"`,
                stock: sql`excluded."stock"`,
                currentPrice: sql`excluded."currentPrice"`,
                regularPrice: sql`excluded."regularPrice"`,
                observedAt: sql`excluded."observedAt"`,
              },
            });
        }

        for (let i = 0; i < stalePairs.length; i += LOCATION_DELETE_CHUNK_SIZE) {
          const slice = stalePairs.slice(i, i + LOCATION_DELETE_CHUNK_SIZE);
          const tuples = sql.join(
            slice.map((pair) => sql`(${pair.productId}, ${pair.locationId})`),
            sql`, `
          );
          await tx
            .delete(productsShopsLocations)
            .where(
              and(
                eq(productsShopsLocations.shopId, shopId),
                sql`(${productsShopsLocations.productId}, ${productsShopsLocations.locationId}) IN (${tuples})`
              )
            );
        }
      });
    }

    return { ok: true, changedProductIds };
  } catch (error) {
    console.error(
      `[STOCK] batch shopId=${shopId} count=${items.length} failed`,
      error
    );
    return { ok: false };
  }
}

/** For tests and one-off scripts that switch databases. */
export function resetLocationIdCache() {
  locationIdsByShop.clear();
}
