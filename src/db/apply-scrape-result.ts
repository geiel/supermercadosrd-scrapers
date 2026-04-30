import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  productsPricesHistory,
  productsShopsPrices,
  type ProductShopPriceRow,
} from "./schema.js";
import type { ScrapePriceResult } from "../types.js";
import { revalidateProduct } from "./revalidate-product.js";

export type ShopPriceRow = Pick<
  ProductShopPriceRow,
  | "productId"
  | "shopId"
  | "url"
  | "api"
  | "locationId"
  | "currentPrice"
  | "regularPrice"
  | "updateAt"
  | "hidden"
>;

function logPrefix(row: ShopPriceRow) {
  return `url=${row.url} productId=${row.productId} shopId=${row.shopId}`;
}

function normalizeUrlForComparison(url: string) {
  return url.trim().replace(/\/+$/, "");
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
        eq(productsShopsPrices.shopId, row.shopId)
      )
    );

  await revalidateProduct(row.productId);
}

async function showProductPrice(row: ShopPriceRow) {
  if (!row.hidden) {
    return;
  }

  await db
    .update(productsShopsPrices)
    .set({
      hidden: false,
    })
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        eq(productsShopsPrices.shopId, row.shopId)
      )
    );

  await revalidateProduct(row.productId);
}

async function touchProductPrice(row: ShopPriceRow) {
  await db
    .update(productsShopsPrices)
    .set({
      updateAt: new Date(),
    })
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        eq(productsShopsPrices.shopId, row.shopId)
      )
    );
}

export async function applyScrapeResult(
  row: ShopPriceRow,
  result: ScrapePriceResult
) {
  if (result.status !== "ok") {
    console.error(
      `[ERROR] ${result.shopName} ${logPrefix(row)} reason=${result.reason}`
    );

    if (result.hide) {
      await hideProductPrice(row);
    }

    return;
  }

  await showProductPrice(row);

  const canonicalUrl = result.canonicalUrl?.trim() || null;
  const urlChanged =
    canonicalUrl !== null &&
    normalizeUrlForComparison(row.url) !== normalizeUrlForComparison(canonicalUrl);
  const priceAndLocationUnchanged =
    row.currentPrice !== null &&
    Number(row.currentPrice) === Number(result.currentPrice) &&
    Number(row.regularPrice ?? 0) === Number(result.regularPrice ?? 0) &&
    (row.locationId ?? null) === (result.locationId ?? null);

  if (priceAndLocationUnchanged && !urlChanged) {
    await touchProductPrice(row);
    console.log(`[IGNORE] ${result.shopName} ${logPrefix(row)}`);
    return;
  }

  if (priceAndLocationUnchanged && urlChanged) {
    await db
      .update(productsShopsPrices)
      .set({
        url: canonicalUrl,
        updateAt: new Date(),
      })
      .where(
        and(
          eq(productsShopsPrices.productId, row.productId),
          eq(productsShopsPrices.shopId, row.shopId),
          sql`${productsShopsPrices.url} IS DISTINCT FROM ${canonicalUrl}`
        )
      );

    await revalidateProduct(row.productId);
    console.log(
      `[DONE] ${result.shopName} ${logPrefix(row)} canonicalUrl=${canonicalUrl}`
    );
    return;
  }

  const currentPriceChanged =
    row.currentPrice === null ||
    Number(row.currentPrice) !== Number(result.currentPrice);

  const updated = await db
    .update(productsShopsPrices)
    .set({
      currentPrice: result.currentPrice,
      regularPrice: result.regularPrice,
      locationId: result.locationId ?? null,
      ...(urlChanged ? { url: canonicalUrl } : {}),
      updateAt: new Date(),
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
            ? [sql`${productsShopsPrices.url} IS DISTINCT FROM ${canonicalUrl}`]
            : [])
        )
      )
    )
    .returning({
      productId: productsShopsPrices.productId,
      currentPrice: productsShopsPrices.currentPrice,
    });

  if (updated.length === 0) {
    console.log(`[DONE/IGNORE] ${result.shopName} ${logPrefix(row)}`);
    return;
  }

  if (currentPriceChanged) {
    await db.insert(productsPricesHistory).values({
      productId: row.productId,
      shopId: row.shopId,
      price: result.currentPrice,
      createdAt: new Date(),
    });
  }

  await revalidateProduct(row.productId);
  console.log(
    `[DONE] ${result.shopName} ${logPrefix(row)} currentPrice=${result.currentPrice}`
  );
}
