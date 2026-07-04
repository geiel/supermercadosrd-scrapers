import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  products,
  productsPricesHistory,
  productsShopsPrices,
  type ProductShopPriceRow,
} from "./schema.js";
import type { ScrapePriceResult, ScrapePriceSuccess } from "../types.js";
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
> & {
  unit?: string | null;
  baseUnit?: string | null;
  baseUnitAmount?: string | number | null;
};

type ProductUnitUpdate = NonNullable<ScrapePriceSuccess["productUnitUpdate"]>;

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

async function applyProductUnitUpdate(
  row: ShopPriceRow,
  unitUpdate: ProductUnitUpdate
) {
  const [product] = await db
    .select({
      id: products.id,
      name: products.name,
      brandId: products.brandId,
      unit: products.unit,
    })
    .from(products)
    .where(eq(products.id, row.productId))
    .limit(1);

  if (!product) {
    console.error(
      `[ERROR] PriceSmart ${logPrefix(row)} unit_update_product_not_found`
    );
    return false;
  }

  if (!product.name || product.brandId === null) {
    console.error(
      `[ERROR] PriceSmart ${logPrefix(row)} unit_update_missing_product_identity`
    );
    return false;
  }

  const [conflictingProduct] = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.name, product.name),
        eq(products.unit, unitUpdate.unit),
        eq(products.brandId, product.brandId),
        ne(products.id, row.productId)
      )
    )
    .limit(1);

  if (conflictingProduct) {
    console.error(
      `[ERROR] PriceSmart ${logPrefix(row)} unit_update_conflicts_with_product=${conflictingProduct.id}`
    );
    return false;
  }

  const updated = await db
    .update(products)
    .set({
      unit: unitUpdate.unit,
      baseUnit: unitUpdate.baseUnit,
      baseUnitAmount: unitUpdate.baseUnitAmount,
    })
    .where(
      and(
        eq(products.id, row.productId),
        or(
          sql`${products.unit} IS DISTINCT FROM ${unitUpdate.unit}`,
          sql`${products.baseUnit} IS DISTINCT FROM ${unitUpdate.baseUnit}`,
          sql`${products.baseUnitAmount} IS DISTINCT FROM ${unitUpdate.baseUnitAmount}`
        )
      )
    )
    .returning({ id: products.id });

  if (updated.length > 0) {
    console.log(
      `[INFO] PriceSmart ${logPrefix(row)} unit=${product.unit ?? "null"} -> ${unitUpdate.unit}`
    );
  }

  return true;
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

  let updatedProductUnit = false;
  if (result.productUnitUpdate) {
    const applied = await applyProductUnitUpdate(row, result.productUnitUpdate);
    if (!applied) {
      await hideProductPrice(row);
      return;
    }

    updatedProductUnit = true;
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
    if (updatedProductUnit) {
      await revalidateProduct(row.productId);
    }
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
    if (updatedProductUnit) {
      await revalidateProduct(row.productId);
    }
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
