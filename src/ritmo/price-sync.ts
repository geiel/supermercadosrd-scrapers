import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { revalidateProduct } from "../db/revalidate-product.js";
import { productsPricesHistory, productsShopsPrices } from "../db/schema.js";
import { isPositivePrice, type RitmoPriceCsvRow } from "./price-csv.js";

const DEFAULT_RITMO_SHOP_ID = 9;
const RITMO_SHOP_URL = "https://tiendasritmo.com/";
const RITMO_SOURCE_PREFIX = "ritmo://sku/";

export type RitmoSftpPriceSyncSummary = {
  dryRun: boolean;
  shopId: number;
  csvRows: number;
  positivePriceRows: number;
  hiddenPriceRows: number;
  matchedRows: number;
  updatedRows: number;
  changedRows: number;
  unchangedRows: number;
  unhiddenRows: number;
  hiddenRows: number;
  historyRowsInserted: number;
  skippedRows: Array<{ sku: string; reason: string }>;
  affectedProductIds: number[];
};

type CurrentRitmoRow = {
  productId: number;
  api: string | null;
  currentPrice: string | null;
  hidden: boolean | null;
};

export type ApplyRitmoSftpPriceSyncInput = {
  rows: RitmoPriceCsvRow[];
  shopId?: number;
  dryRun?: boolean;
};

function normalizeText(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function getRitmoSourceUrl(sku: string) {
  return `${RITMO_SOURCE_PREFIX}${encodeURIComponent(normalizeText(sku))}`;
}

function getRitmoSourceUrlCandidates(sku: string) {
  const normalizedSku = normalizeText(sku);
  const encodedSourceUrl = getRitmoSourceUrl(normalizedSku);
  const rawSourceUrl = `${RITMO_SOURCE_PREFIX}${normalizedSku}`;

  return Array.from(new Set([encodedSourceUrl, rawSourceUrl]));
}

function pricesEqual(left: string | null, right: string | null) {
  const leftPrice = Number(left);
  const rightPrice = Number(right);

  return (
    Number.isFinite(leftPrice) &&
    Number.isFinite(rightPrice) &&
    Math.abs(leftPrice - rightPrice) < 0.005
  );
}

function getRitmoShopId(inputShopId?: number) {
  const parsed = Number(inputShopId ?? process.env.RITMO_SHOP_ID);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return DEFAULT_RITMO_SHOP_ID;
}

function uniqueRowsBySku(rows: RitmoPriceCsvRow[]) {
  const bySku = new Map<string, RitmoPriceCsvRow>();

  for (const row of rows) {
    const sku = normalizeText(row.sku);
    if (!sku || bySku.has(sku)) {
      continue;
    }

    bySku.set(sku, {
      ...row,
      sku,
    });
  }

  return Array.from(bySku.values());
}

function buildCurrentRowLookup(rows: CurrentRitmoRow[]) {
  return new Map(
    rows
      .filter((row) => row.api)
      .map((row) => [
        row.api as string,
        {
          ...row,
          currentPrice: row.currentPrice ? String(row.currentPrice) : null,
        },
      ])
  );
}

async function revalidateAffectedProducts(productIds: number[]) {
  for (const productId of productIds) {
    await revalidateProduct(productId);
  }
}

export async function applyRitmoSftpPriceSync(
  input: ApplyRitmoSftpPriceSyncInput
): Promise<RitmoSftpPriceSyncSummary> {
  const shopId = getRitmoShopId(input.shopId);
  const rows = uniqueRowsBySku(input.rows);
  const positiveRows = rows.filter((row) => isPositivePrice(row.price));
  const positiveSourceUrls = Array.from(
    new Set(positiveRows.flatMap((row) => getRitmoSourceUrlCandidates(row.sku)))
  );
  const dryRun = input.dryRun === true;

  const summary: RitmoSftpPriceSyncSummary = {
    dryRun,
    shopId,
    csvRows: rows.length,
    positivePriceRows: positiveRows.length,
    hiddenPriceRows: rows.length - positiveRows.length,
    matchedRows: 0,
    updatedRows: 0,
    changedRows: 0,
    unchangedRows: 0,
    unhiddenRows: 0,
    hiddenRows: 0,
    historyRowsInserted: 0,
    skippedRows: [],
    affectedProductIds: [],
  };

  const affectedProductIds = new Set<number>();
  const currentRows =
    positiveSourceUrls.length > 0
      ? await db
          .select({
            productId: productsShopsPrices.productId,
            api: productsShopsPrices.api,
            currentPrice: productsShopsPrices.currentPrice,
            hidden: productsShopsPrices.hidden,
          })
          .from(productsShopsPrices)
          .where(
            and(
              eq(productsShopsPrices.shopId, shopId),
              inArray(productsShopsPrices.api, positiveSourceUrls)
            )
          )
      : [];
  const currentByApi = buildCurrentRowLookup(currentRows);
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const row of positiveRows) {
      const canonicalSourceUrl = getRitmoSourceUrl(row.sku);
      const current = getRitmoSourceUrlCandidates(row.sku)
        .map((sourceUrl) => currentByApi.get(sourceUrl))
        .find((candidate): candidate is CurrentRitmoRow => Boolean(candidate));

      if (!current) {
        summary.skippedRows.push({ sku: row.sku, reason: "sku-not-linked" });
        continue;
      }

      summary.matchedRows += 1;

      const price = row.price as string;
      const priceChanged = !pricesEqual(price, current.currentPrice);
      const wasHidden = current.hidden === true;

      if (priceChanged) {
        summary.changedRows += 1;
      } else {
        summary.unchangedRows += 1;
      }

      if (wasHidden) {
        summary.unhiddenRows += 1;
      }

      if (!dryRun) {
        await tx
          .update(productsShopsPrices)
          .set({
            url: RITMO_SHOP_URL,
            api: canonicalSourceUrl,
            currentPrice: price,
            updateAt: now,
            hidden: false,
          })
          .where(
            and(
              eq(productsShopsPrices.productId, current.productId),
              eq(productsShopsPrices.shopId, shopId)
            )
          );

        if (priceChanged) {
          await tx.insert(productsPricesHistory).values({
            productId: current.productId,
            shopId,
            price,
            createdAt: now,
          });
          summary.historyRowsInserted += 1;
        }
      }

      summary.updatedRows += 1;

      if (priceChanged || wasHidden) {
        affectedProductIds.add(current.productId);
      }
    }

    const hideWhere = and(
      eq(productsShopsPrices.shopId, shopId),
      sql`${productsShopsPrices.api} like ${`${RITMO_SOURCE_PREFIX}%`}`,
      positiveSourceUrls.length > 0
        ? sql`${productsShopsPrices.api} not in (${sql.join(
            positiveSourceUrls.map((sourceUrl) => sql`${sourceUrl}`),
            sql`, `
          )})`
        : undefined,
      or(isNull(productsShopsPrices.hidden), eq(productsShopsPrices.hidden, false))
    );
    const rowsToHide = dryRun
      ? await tx
          .select({
            productId: productsShopsPrices.productId,
          })
          .from(productsShopsPrices)
          .where(hideWhere)
      : await tx
          .update(productsShopsPrices)
          .set({
            hidden: true,
            updateAt: now,
          })
          .where(hideWhere)
          .returning({
            productId: productsShopsPrices.productId,
          });

    summary.hiddenRows = rowsToHide.length;
    rowsToHide.forEach((row) => affectedProductIds.add(row.productId));

  });

  summary.affectedProductIds = Array.from(affectedProductIds);

  if (!dryRun) {
    await revalidateAffectedProducts(summary.affectedProductIds);
  }

  return summary;
}
