import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
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
  executeScrapeResultsBatch,
  normalizeUrlForComparison,
  purchaseTermsChanged,
  purchaseTermsPatch,
  type ApplyScrapeResultOptions,
  type ScrapeWriteEntry,
  type ShopPriceRow,
} from "./scrape-write-plan.js";

export type { ShopPriceRow } from "./scrape-write-plan.js";

type ProductMeasurementUpdate = NonNullable<
  ScrapePriceSuccess["productMeasurementUpdate"]
>;

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
  // Compares against the snapshot loaded at the start of the run (safe because
  // per-shop sync workflows do not overlap; avoids a second roundtrip/tx).
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

async function batchTouchUnchangedRows(
  shopId: number,
  shopName: string,
  hasPurchaseTerms: boolean,
  expectedOutOfStockOnline: boolean | null | undefined,
  entries: readonly ScrapeWriteEntry[]
): Promise<ScrapeWriteEntry[]> {
  const unmatched: ScrapeWriteEntry[] = [];
  let touchedTotal = 0;

  // Lock rows in ascending productId order (matching applyStockSignalsBatch) so
  // concurrent jobs touching the same shop cannot deadlock on lock order.
  const sorted = [...entries].sort((a, b) => a[0].productId - b[0].productId);

  for (let i = 0; i < sorted.length; i += BATCH_TOUCH_CHUNK_SIZE) {
    const chunk = sorted.slice(i, i + BATCH_TOUCH_CHUNK_SIZE);
    const productIds = chunk.map(([row]) => row.productId);

    try {
      const idList = sql.join(
        productIds.map((id) => sql`${id}`),
        sql`, `
      );
      const oosClause =
        expectedOutOfStockOnline === undefined
          ? sql``
          : sql`AND "outOfStockOnline" IS NOT DISTINCT FROM ${expectedOutOfStockOnline}::boolean`;
      const termsClause = hasPurchaseTerms
        ? sql`, "purchaseTermsObservedAt" = now()`
        : sql``;

      const touched = await db.execute<{ productId: number }>(sql`
        WITH locked AS MATERIALIZED (
          SELECT "productId"
          FROM products_shops_prices
          WHERE "shopId" = ${shopId}
            AND "productId" IN (${idList})
            AND (hidden IS NULL OR hidden = false)
            ${oosClause}
          ORDER BY "productId" ASC
          FOR UPDATE
        )
        UPDATE products_shops_prices AS p
        SET hidden = false, "updateAt" = now()${termsClause}
        FROM locked
        WHERE p."shopId" = ${shopId}
          AND p."productId" = locked."productId"
        RETURNING p."productId" AS "productId"
      `);

      const touchedIds = new Set(
        touched.map((row) => Number(row.productId))
      );
      touchedTotal += touchedIds.size;
      for (const entry of chunk) {
        if (!touchedIds.has(entry[0].productId)) {
          unmatched.push(entry);
        }
      }
    } catch (error) {
      console.error(
        `[TOUCH] ${shopName} batch shopId=${shopId} chunkSize=${chunk.length} failed`,
        error
      );
      unmatched.push(...chunk);
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
 * - Price/URL/terms/visibility/stock changes run first via applyScrapeResult.
 * - Unchanged visible rows without branch locations share chunked UPDATEs.
 * - Rows with branch locations (Merca Jumbo) share batched stock-signal
 *   transactions and chunked touch UPDATEs.
 */
export async function applyScrapeResultsBatch(
  entries: readonly ScrapeWriteEntry[],
  options: { concurrency?: number } = {}
) {
  await executeScrapeResultsBatch(
    entries,
    {
      batchTouch: batchTouchUnchangedRows,
      applyStockBatch: (shopId, items) =>
        applyStockSignalsBatch(
          shopId,
          items.map(({ row, result }) => ({
            offer: {
              productId: row.productId,
              shopId: row.shopId,
              url: row.url,
              api: row.api,
            },
            result,
          }))
        ),
      applyIndividual: applyScrapeResult,
      revalidateProduct,
    },
    options
  );
}
