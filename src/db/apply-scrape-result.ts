import { and, eq, isNull, ne, or } from "drizzle-orm";
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
  | "currentPrice"
  | "regularPrice"
  | "updateAt"
  | "hidden"
>;

function logPrefix(row: ShopPriceRow) {
  return `url=${row.url} productId=${row.productId} shopId=${row.shopId}`;
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

  if (
    row.currentPrice !== null &&
    Number(row.currentPrice) === Number(result.currentPrice)
  ) {
    await touchProductPrice(row);
    console.log(`[IGNORE] ${result.shopName} ${logPrefix(row)}`);
    return;
  }

  const updated = await db
    .update(productsShopsPrices)
    .set({
      currentPrice: result.currentPrice,
      regularPrice: result.regularPrice,
      updateAt: new Date(),
    })
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        eq(productsShopsPrices.shopId, row.shopId),
        or(
          isNull(productsShopsPrices.currentPrice),
          ne(productsShopsPrices.currentPrice, result.currentPrice)
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

  await db.insert(productsPricesHistory).values({
    productId: row.productId,
    shopId: row.shopId,
    price: result.currentPrice,
    createdAt: new Date(),
  });

  await revalidateProduct(row.productId);
  console.log(
    `[DONE] ${result.shopName} ${logPrefix(row)} currentPrice=${result.currentPrice}`
  );
}
