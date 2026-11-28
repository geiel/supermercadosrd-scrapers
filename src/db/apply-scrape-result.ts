import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  measurementTypes,
  productMeasurements,
  productsShopsPrices,
} from "./schema.js";
import {
  productPriceStatesEqual,
  recordProductPriceStateInTransaction,
} from "./product-price-history.js";
import type { ScrapePriceResult, ScrapePriceSuccess } from "../types.js";
import type { PurchaseTerms } from "../purchase-terms.js";
import { revalidateProduct } from "./revalidate-product.js";
import { relinkBravoOffer } from "./bravo-relink-offer.js";
import { applyStockSignals, applyStockSignalsBatch } from "./offer-stock.js";
import {
  classifyScrapeWrite,
  normalizeUrlForComparison,
  partitionUniqueBatchEntries,
  purchaseTermsChanged,
  purchaseTermsPatch,
  type ShopPriceRow,
} from "./scrape-write-plan.js";
import { mapWithConcurrency } from "../utils.js";

export type { ShopPriceRow } from "./scrape-write-plan.js";

type ProductMeasurementUpdate = NonNullable<
  ScrapePriceSuccess["productMeasurementUpdate"]
>;

type ApplyScrapeResultOptions = {
  /** Stock signals were already applied in a batch transaction. */
  skipStockSignals?: boolean;
  /** Whether the preceding batch stock sync changed anything visible. */
  stockChanged?: boolean;
};

const BATCH_TOUCH_CHUNK_SIZE = 250;

function logPrefix(row: ShopPriceRow) {
  return `url=${row.url} productId=${row.productId} shopId=${row.shopId}`;
}

function guardedOutOfStockOnlineSql(
  row: Pick<ShopPriceRow, "url" | "api">,
  outOfStockOnline: boolean | null
) {
  return sql<boolean | null>`CASE
    WHEN ${productsShopsPrices.url} = ${row.url}
     AND ${productsShopsPrices.api} IS NOT DISTINCT FROM ${row.api ?? null}
    THEN ${outOfStockOnline}::boolean
    ELSE ${productsShopsPrices.outOfStockOnline}
  END`;
}

function guardedOutOfStockChangedCondition(
  row: Pick<ShopPriceRow, "url" | "api">,
  outOfStockOnline: boolean | null
) {
  return sql`(${productsShopsPrices.url} = ${row.url} AND ${productsShopsPrices.api} IS NOT DISTINCT FROM ${row.api ?? null} AND ${productsShopsPrices.outOfStockOnline} IS DISTINCT FROM ${outOfStockOnline}::boolean)`;
}

async function hideProductPrice(row: ShopPriceRow) {
  await db
    .update(productsShopsPrices)
    .set({
      hidden: true,
      updateAt: new Date(),
    })
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        eq(productsShopsPrices.shopId, row.shopId),
        // Hide only the offer that failed: if another run or an admin moved
        // it to a new api or url meanwhile (a Bravo relink, a fixed link),
        // that change stands.
        sql`${productsShopsPrices.api} IS NOT DISTINCT FROM ${row.api ?? null}`,
        eq(productsShopsPrices.url, row.url)
      )
    );

  await revalidateProduct(row.productId);
}

async function productHasOtherVisibleShopPrices(
  row: ShopPriceRow,
  client: Pick<typeof db, "select"> = db
) {
  const otherShopPrice = await client
    .select({ productId: productsShopsPrices.productId })
    .from(productsShopsPrices)
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        ne(productsShopsPrices.shopId, row.shopId),
        sql`${productsShopsPrices.currentPrice} IS NOT NULL`,
        or(
          isNull(productsShopsPrices.hidden),
          eq(productsShopsPrices.hidden, false)
        )
      )
    )
    .limit(1);

  return otherShopPrice.length > 0;
}

async function touchProductPrice(
  row: ShopPriceRow,
  purchaseTerms: PurchaseTerms | null | undefined,
  inlineOutOfStock?: boolean | null
): Promise<boolean> {
  const query = db
    .update(productsShopsPrices)
    .set({
      hidden: false,
      updateAt: new Date(),
      ...(purchaseTerms === undefined ? {} : purchaseTermsPatch(purchaseTerms)),
      ...(inlineOutOfStock === undefined
        ? {}
        : {
            outOfStockOnline: guardedOutOfStockOnlineSql(row, inlineOutOfStock),
          }),
    })
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        eq(productsShopsPrices.shopId, row.shopId)
      )
    );

  if (inlineOutOfStock === undefined) {
    await query;
    return false;
  }

  const updated = await query.returning({
    outOfStockOnline: productsShopsPrices.outOfStockOnline,
  });
  return (
    updated.length > 0 &&
    row.outOfStockOnline !== undefined &&
    updated[0].outOfStockOnline !== row.outOfStockOnline
  );
}

async function applyProductMeasurementUpdate(
  row: ShopPriceRow,
  update: ProductMeasurementUpdate
) {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`select id from products where id=${row.productId} for update`
    );
    if (!locked.length) return false;
    // Do not let a shop-specific variable-weight pack redefine a shared product.
    const types = await tx
      .select({ id: measurementTypes.id })
      .from(measurementTypes)
      .where(
        and(
          eq(measurementTypes.dimension, "mass"),
          eq(measurementTypes.quantityKind, "net_content")
        )
      );
    if (types.length !== 1) return false;
    const current = await tx
      .select()
      .from(productMeasurements)
      .where(
        and(
          eq(productMeasurements.productId, row.productId),
          eq(productMeasurements.measurementTypeId, types[0].id),
          sql`${productMeasurements.status} in ('verified','inferred','rejected')`
        )
      );
    const matches = (m: (typeof current)[number]) =>
      Math.abs(Number(m.canonicalQuantity) - Number(update.canonicalQuantity)) <=
      0.001;
    if (current.some((m) => m.status === "verified" && !matches(m)))
      return false;
    if (current.some((m) => m.status !== "rejected" && matches(m))) return true;
    if (current.some((m) => m.status === "rejected" && matches(m)))
      return false;
    if (await productHasOtherVisibleShopPrices(row, tx)) return false;
    await tx.insert(productMeasurements).values({
      productId: row.productId,
      measurementTypeId: types[0].id,
      ...update,
      status: "inferred",
      evidenceType: "retailer_source",
      sourceUrl: row.url,
      evidence: {
        source: "pricesmart",
        api: row.api,
        locationId: row.locationId,
        observedAt: new Date().toISOString(),
      },
    });
    return true;
  });
}

export async function applyScrapeResult(
  row: ShopPriceRow,
  result: ScrapePriceResult,
  options: ApplyScrapeResultOptions = {}
) {
  if (result.status !== "ok") {
    console.error(
      `[ERROR] ${result.shopName} ${logPrefix(row)} reason=${result.reason}`
    );

    if (result.status === "not_found" && row.shopId === 6) {
      const relink = await relinkBravoOffer(row).catch((error: unknown) => {
        console.error(`[RELINK] bravo ${logPrefix(row)} failed`, error);
        return { status: "not_relinked" } as const;
      });
      if (relink.status === "relinked") {
        await applyScrapeResult({ ...row, api: relink.api }, relink.result);
        return;
      }
      // Another run already moved this offer; hiding now would undo its work.
      if (relink.status === "offer_changed") {
        return;
      }
    }

    if (result.hide) {
      await hideProductPrice(row);
    }

    return;
  }

  let updatedProductMeasurement = false;
  if (result.productMeasurementUpdate) {
    const applied = await applyProductMeasurementUpdate(
      row,
      result.productMeasurementUpdate
    );
    if (!applied) {
      await hideProductPrice(row);
      return;
    }

    updatedProductMeasurement = true;
  }

  // When a store has no branch rows and the caller loaded outOfStockOnline,
  // fold it into the price UPDATE below instead of opening a separate
  // transaction (1 roundtrip instead of 5).
  const canInlineOutOfStock =
    !options.skipStockSignals &&
    result.locations === undefined &&
    result.outOfStockOnline !== undefined &&
    row.outOfStockOnline !== undefined;
  const inlineOutOfStock = canInlineOutOfStock
    ? result.outOfStockOnline
    : undefined;

  let stockChanged = options.stockChanged ?? false;
  if (!options.skipStockSignals && !canInlineOutOfStock) {
    stockChanged = await applyStockSignals(row, result);
  }

  const canonicalUrl = result.canonicalUrl?.trim() || null;
  const termsChanged = purchaseTermsChanged(row, result.purchaseTerms);
  const termsPatch =
    result.purchaseTerms === undefined
      ? {}
      : purchaseTermsPatch(result.purchaseTerms);
  const urlChanged =
    canonicalUrl !== null &&
    normalizeUrlForComparison(row.url) !==
      normalizeUrlForComparison(canonicalUrl);
  const priceAndLocationUnchanged =
    row.currentPrice !== null &&
    productPriceStatesEqual(
      { price: row.currentPrice, regularPrice: row.regularPrice },
      { price: result.currentPrice, regularPrice: result.regularPrice }
    ) &&
    (row.locationId ?? null) === (result.locationId ?? null);

  if (priceAndLocationUnchanged && !urlChanged && !termsChanged) {
    const inlineChanged = await touchProductPrice(
      row,
      result.purchaseTerms,
      inlineOutOfStock
    );
    stockChanged = stockChanged || inlineChanged;
    if (updatedProductMeasurement || row.hidden || stockChanged) {
      await revalidateProduct(row.productId);
    }
    console.log(
      `[IGNORE] ${result.shopName} ${logPrefix(row)}${stockChanged ? " stock=updated" : ""}`
    );
    return;
  }

  if (priceAndLocationUnchanged && (urlChanged || termsChanged)) {
    await db
      .update(productsShopsPrices)
      .set({
        hidden: false,
        ...(urlChanged ? { url: canonicalUrl } : {}),
        ...termsPatch,
        ...(inlineOutOfStock === undefined
          ? {}
          : {
              outOfStockOnline: guardedOutOfStockOnlineSql(
                row,
                inlineOutOfStock
              ),
            }),
        updateAt: new Date(),
      })
      .where(
        and(
          eq(productsShopsPrices.productId, row.productId),
          eq(productsShopsPrices.shopId, row.shopId),
          or(
            ...(urlChanged
              ? [
                  sql`${productsShopsPrices.url} IS DISTINCT FROM ${canonicalUrl}`,
                ]
              : []),
            ...(termsChanged ? [sql`TRUE`] : []),
            ...(inlineOutOfStock === undefined
              ? []
              : [guardedOutOfStockChangedCondition(row, inlineOutOfStock)])
          )
        )
      );

    await revalidateProduct(row.productId);
    console.log(
      `[DONE] ${result.shopName} ${logPrefix(row)}${urlChanged ? ` canonicalUrl=${canonicalUrl}` : ""}${termsChanged ? " purchaseTerms=updated" : ""}`
    );
    return;
  }

  const priceStateChanged = !productPriceStatesEqual(
    { price: row.currentPrice, regularPrice: row.regularPrice },
    { price: result.currentPrice, regularPrice: result.regularPrice }
  );
  const observedAt = new Date();

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(productsShopsPrices)
      .set({
        currentPrice: result.currentPrice,
        regularPrice: result.regularPrice,
        locationId: result.locationId ?? null,
        hidden: false,
        ...(urlChanged ? { url: canonicalUrl } : {}),
        ...termsPatch,
        ...(inlineOutOfStock === undefined
          ? {}
          : {
              outOfStockOnline: guardedOutOfStockOnlineSql(
                row,
                inlineOutOfStock
              ),
            }),
        updateAt: observedAt,
      })
      .where(
        and(
          eq(productsShopsPrices.productId, row.productId),
          eq(productsShopsPrices.shopId, row.shopId),
          or(
            isNull(productsShopsPrices.currentPrice),
            ne(productsShopsPrices.currentPrice, result.currentPrice),
            sql`${productsShopsPrices.regularPrice} IS DISTINCT FROM ${result.regularPrice}`,
            sql`${productsShopsPrices.locationId} IS DISTINCT FROM ${result.locationId ?? null}`,
            ...(urlChanged
              ? [
                  sql`${productsShopsPrices.url} IS DISTINCT FROM ${canonicalUrl}`,
                ]
              : []),
            ...(inlineOutOfStock === undefined
              ? []
              : [guardedOutOfStockChangedCondition(row, inlineOutOfStock)])
          )
        )
      )
      .returning({
        productId: productsShopsPrices.productId,
        currentPrice: productsShopsPrices.currentPrice,
      });

    if (rows.length > 0 && priceStateChanged) {
      await recordProductPriceStateInTransaction(tx, {
        productId: row.productId,
        shopId: row.shopId,
        price: result.currentPrice,
        regularPrice: result.regularPrice,
        createdAt: observedAt,
      });
    }

    return rows;
  });

  if (updated.length === 0) {
    if (updatedProductMeasurement || stockChanged) {
      await revalidateProduct(row.productId);
    }
    console.log(`[DONE/IGNORE] ${result.shopName} ${logPrefix(row)}`);
    return;
  }

  await revalidateProduct(row.productId);
  console.log(
    `[DONE] ${result.shopName} ${logPrefix(row)} currentPrice=${result.currentPrice}`
  );
}

type ScrapeWriteEntry = readonly [ShopPriceRow, ScrapePriceResult];

async function batchTouchUnchangedRows(
  shopId: number,
  shopName: string,
  hasPurchaseTerms: boolean,
  expectedOutOfStockOnline: boolean | null | undefined,
  entries: readonly ScrapeWriteEntry[]
): Promise<ScrapeWriteEntry[]> {
  const unmatched: ScrapeWriteEntry[] = [];
  let touchedTotal = 0;

  for (let i = 0; i < entries.length; i += BATCH_TOUCH_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + BATCH_TOUCH_CHUNK_SIZE);
    const productIds = chunk.map(([row]) => row.productId);
    const now = new Date();
    const touched = await db
      .update(productsShopsPrices)
      .set({
        hidden: false,
        updateAt: now,
        ...(hasPurchaseTerms ? { purchaseTermsObservedAt: now } : {}),
      })
      .where(
        and(
          eq(productsShopsPrices.shopId, shopId),
          inArray(productsShopsPrices.productId, productIds),
          or(
            isNull(productsShopsPrices.hidden),
            eq(productsShopsPrices.hidden, false)
          ),
          ...(expectedOutOfStockOnline === undefined
            ? []
            : [
                sql`${productsShopsPrices.outOfStockOnline} IS NOT DISTINCT FROM ${expectedOutOfStockOnline}::boolean`,
              ])
        )
      )
      .returning({ productId: productsShopsPrices.productId });

    const touchedIds = new Set(touched.map((row) => row.productId));
    touchedTotal += touchedIds.size;
    for (const entry of chunk) {
      if (!touchedIds.has(entry[0].productId)) {
        unmatched.push(entry);
      }
    }
  }

  if (touchedTotal > 0) {
    console.log(
      `[IGNORE] ${shopName} batch=${touchedTotal} shopId=${shopId}`
    );
  }

  return unmatched;
}

/**
 * Applies a batch of scrape results with minimal Postgres roundtrips:
 * - Unchanged visible rows without branch locations share chunked UPDATEs.
 * - Rows with branch locations (Merca Jumbo) share batched stock-signal
 *   transactions and chunked touch UPDATEs.
 * - Rows with price/URL/terms/visibility/stock changes or errors fall back to
 *   applyScrapeResult.
 */
export async function applyScrapeResultsBatch(
  entries: readonly ScrapeWriteEntry[],
  options: { concurrency?: number } = {}
) {
  if (entries.length === 0) {
    return;
  }

  const concurrency = Math.max(1, options.concurrency ?? 2);
  const { unique, duplicates } = partitionUniqueBatchEntries(entries);

  type TouchBucket = {
    shopId: number;
    shopName: string;
    hasPurchaseTerms: boolean;
    expectedOutOfStockOnline: boolean | null | undefined;
    entries: ScrapeWriteEntry[];
  };

  type LocationBatchItem = {
    entry: readonly [ShopPriceRow, ScrapePriceSuccess];
    canBatchTouchAfterStock: boolean;
    hasPurchaseTerms: boolean;
  };

  const touchBuckets = new Map<string, TouchBucket>();
  const locationsByShop = new Map<number, LocationBatchItem[]>();
  const individual: ScrapeWriteEntry[] = [];

  for (const entry of unique) {
    const [row, result] = entry;
    const plan = classifyScrapeWrite(row, result);

    if (plan.kind === "batch_touch") {
      const oosKey =
        plan.expectedOutOfStockOnline === undefined
          ? "none"
          : String(plan.expectedOutOfStockOnline);
      const key = `${row.shopId}:${plan.hasPurchaseTerms ? 1 : 0}:${oosKey}`;
      let bucket = touchBuckets.get(key);
      if (!bucket) {
        bucket = {
          shopId: row.shopId,
          shopName: result.shopName,
          hasPurchaseTerms: plan.hasPurchaseTerms,
          expectedOutOfStockOnline: plan.expectedOutOfStockOnline,
          entries: [],
        };
        touchBuckets.set(key, bucket);
      }
      bucket.entries.push(entry);
      continue;
    }

    if (plan.kind === "batch_locations" && result.status === "ok") {
      const list = locationsByShop.get(row.shopId);
      const item: LocationBatchItem = {
        entry: [row, result],
        canBatchTouchAfterStock: plan.canBatchTouchAfterStock,
        hasPurchaseTerms: plan.hasPurchaseTerms,
      };
      if (list) {
        list.push(item);
      } else {
        locationsByShop.set(row.shopId, [item]);
      }
      continue;
    }

    individual.push(entry);
  }

  // 1. Batch-touch unchanged non-branch rows; any row whose DB state drifted
  //    mid-run (e.g. hidden or outOfStockOnline changed) falls back below.
  for (const bucket of touchBuckets.values()) {
    const unmatched = await batchTouchUnchangedRows(
      bucket.shopId,
      bucket.shopName,
      bucket.hasPurchaseTerms,
      bucket.expectedOutOfStockOnline,
      bucket.entries
    );
    individual.push(...unmatched);
  }

  // 2. Batch branch-stock rows per shop (e.g. Merca Jumbo).
  const postStockIndividual: Array<{
    entry: readonly [ShopPriceRow, ScrapePriceSuccess];
    stockChanged: boolean;
  }> = [];
  const productIdsToRevalidate: number[] = [];

  for (const [shopId, items] of locationsByShop) {
    const stockOutcome = await applyStockSignalsBatch(
      shopId,
      items.map(({ entry: [row, result] }) => ({
        offer: {
          productId: row.productId,
          shopId: row.shopId,
          url: row.url,
          api: row.api,
        },
        result,
      }))
    );

    if (!stockOutcome.ok) {
      for (const item of items) {
        individual.push(item.entry);
      }
      continue;
    }

    const touchByTerms = new Map<boolean, ScrapeWriteEntry[]>();
    for (const item of items) {
      if (item.canBatchTouchAfterStock) {
        const list = touchByTerms.get(item.hasPurchaseTerms);
        if (list) {
          list.push(item.entry);
        } else {
          touchByTerms.set(item.hasPurchaseTerms, [item.entry]);
        }
      } else {
        postStockIndividual.push({
          entry: item.entry,
          stockChanged: stockOutcome.changedProductIds.has(
            item.entry[0].productId
          ),
        });
      }
    }

    const shopName = items[0].entry[1].shopName;
    for (const [hasPurchaseTerms, touchEntries] of touchByTerms) {
      const unmatched = await batchTouchUnchangedRows(
        shopId,
        shopName,
        hasPurchaseTerms,
        undefined,
        touchEntries
      );
      const unmatchedIds = new Set(unmatched.map(([row]) => row.productId));
      for (const [row, result] of touchEntries) {
        const stockChanged = stockOutcome.changedProductIds.has(row.productId);
        if (unmatchedIds.has(row.productId)) {
          postStockIndividual.push({
            entry: [row, result as ScrapePriceSuccess],
            stockChanged,
          });
        } else if (stockChanged) {
          productIdsToRevalidate.push(row.productId);
        }
      }
    }
  }

  if (productIdsToRevalidate.length > 0) {
    await mapWithConcurrency(
      productIdsToRevalidate,
      concurrency,
      (productId) => revalidateProduct(productId)
    );
  }

  if (postStockIndividual.length > 0) {
    await mapWithConcurrency(
      postStockIndividual,
      concurrency,
      ({ entry: [row, result], stockChanged }) =>
        applyScrapeResult(row, result, { skipStockSignals: true, stockChanged })
    );
  }

  if (individual.length > 0) {
    await mapWithConcurrency(individual, concurrency, ([row, result]) =>
      applyScrapeResult(row, result)
    );
  }

  // Duplicate keys (should not happen in normal runs) run sequentially so
  // ordering is preserved without intra-statement conflicts.
  for (const [row, result] of duplicates) {
    await applyScrapeResult(row, result);
  }
}
