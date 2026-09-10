import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  productMeasurements, measurementTypes,
  productsShopsPrices,
  type ProductShopPriceRow,
} from "./schema.js";
import {
  productPriceStatesEqual,
  recordProductPriceStateInTransaction,
} from "./product-price-history.js";
import type { ScrapePriceResult, ScrapePriceSuccess } from "../types.js";
import type { PurchaseTerms } from "../purchase-terms.js";
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
  | "purchaseMode"
  | "purchaseUnit"
  | "minimumPurchaseQuantity"
  | "purchaseQuantityIncrement"
  | "maximumPurchaseQuantity"
  | "priceReferenceQuantity"
  | "purchaseTermsSource"
  | "updateAt"
  | "hidden"
> & {
  presentation?: string | null;

};

type ProductMeasurementUpdate = NonNullable<ScrapePriceSuccess["productMeasurementUpdate"]>;

function purchaseTermsPatch(purchaseTerms: PurchaseTerms | null) {
  if (purchaseTerms === null) {
    return {
      purchaseMode: null,
      purchaseUnit: null,
      minimumPurchaseQuantity: null,
      purchaseQuantityIncrement: null,
      maximumPurchaseQuantity: null,
      priceReferenceQuantity: null,
      purchaseTermsSource: null,
      purchaseTermsEvidence: null,
      purchaseTermsObservedAt: new Date(),
    };
  }

  return {
    purchaseMode: purchaseTerms.mode,
    purchaseUnit: purchaseTerms.unit,
    minimumPurchaseQuantity: purchaseTerms.minimum,
    purchaseQuantityIncrement: purchaseTerms.increment,
    maximumPurchaseQuantity: purchaseTerms.maximum,
    priceReferenceQuantity: purchaseTerms.priceReferenceQuantity,
    purchaseTermsSource: purchaseTerms.source,
    purchaseTermsEvidence: purchaseTerms.evidence,
    purchaseTermsObservedAt: new Date(),
  };
}

function purchaseTermsChanged(
  row: ShopPriceRow,
  purchaseTerms: PurchaseTerms | null | undefined
) {
  if (purchaseTerms === undefined) {
    return false;
  }

  const expected = purchaseTermsPatch(purchaseTerms);
  return (
    (row.purchaseMode ?? null) !== expected.purchaseMode ||
    (row.purchaseUnit ?? null) !== expected.purchaseUnit ||
    Number(row.minimumPurchaseQuantity ?? 0) !==
      Number(expected.minimumPurchaseQuantity ?? 0) ||
    Number(row.purchaseQuantityIncrement ?? 0) !==
      Number(expected.purchaseQuantityIncrement ?? 0) ||
    Number(row.maximumPurchaseQuantity ?? 0) !==
      Number(expected.maximumPurchaseQuantity ?? 0) ||
    Number(row.priceReferenceQuantity ?? 0) !==
      Number(expected.priceReferenceQuantity ?? 0) ||
    (row.purchaseTermsSource ?? null) !== expected.purchaseTermsSource
  );
}

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

async function productHasOtherVisibleShopPrices(row: ShopPriceRow, client: Pick<typeof db, "select"> = db) {
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
  purchaseTerms: PurchaseTerms | null | undefined
) {
  await db
    .update(productsShopsPrices)
    .set({
      hidden: false,
      updateAt: new Date(),
      ...(purchaseTerms === undefined ? {} : purchaseTermsPatch(purchaseTerms)),
    })
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        eq(productsShopsPrices.shopId, row.shopId)
      )
    );
}

async function applyProductMeasurementUpdate(row: ShopPriceRow, update: ProductMeasurementUpdate) {
  return db.transaction(async tx => {
    const locked = await tx.execute(sql`select id from products where id=${row.productId} for update`);
    if (!locked.length) return false;
    // Do not let a shop-specific variable-weight pack redefine a shared product.
    const types = await tx.select({id:measurementTypes.id}).from(measurementTypes)
      .where(and(eq(measurementTypes.dimension,"mass"),eq(measurementTypes.quantityKind,"net_content")));
    if(types.length!==1) return false;
    const current = await tx.select().from(productMeasurements).where(and(
      eq(productMeasurements.productId,row.productId),eq(productMeasurements.measurementTypeId,types[0].id),
      sql`${productMeasurements.status} in ('verified','inferred','rejected')`));
    const matches = (m: typeof current[number]) => Math.abs(Number(m.canonicalQuantity)-Number(update.canonicalQuantity))<=0.001;
    if(current.some(m=>m.status==='verified'&&!matches(m))) return false;
    if(current.some(m=>m.status!=='rejected' && matches(m))) return true;
    if(current.some(m=>m.status==='rejected' && matches(m))) return false;
    if (await productHasOtherVisibleShopPrices(row, tx)) return false;
    await tx.insert(productMeasurements).values({productId:row.productId,measurementTypeId:types[0].id,...update,
      status:"inferred",evidenceType:"retailer_source",sourceUrl:row.url,
      evidence:{source:"pricesmart",api:row.api,locationId:row.locationId,observedAt:new Date().toISOString()}});
    return true;
  });
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

  let updatedProductMeasurement = false;
  if (result.productMeasurementUpdate) {
    const applied = await applyProductMeasurementUpdate(row, result.productMeasurementUpdate);
    if (!applied) {
      await hideProductPrice(row);
      return;
    }

    updatedProductMeasurement = true;
  }

  const canonicalUrl = result.canonicalUrl?.trim() || null;
  const termsChanged = purchaseTermsChanged(row, result.purchaseTerms);
  const termsPatch =
    result.purchaseTerms === undefined
      ? {}
      : purchaseTermsPatch(result.purchaseTerms);
  const urlChanged =
    canonicalUrl !== null &&
    normalizeUrlForComparison(row.url) !== normalizeUrlForComparison(canonicalUrl);
  const priceAndLocationUnchanged =
    row.currentPrice !== null &&
    productPriceStatesEqual(
      { price: row.currentPrice, regularPrice: row.regularPrice },
      { price: result.currentPrice, regularPrice: result.regularPrice }
    ) &&
    (row.locationId ?? null) === (result.locationId ?? null);

  if (priceAndLocationUnchanged && !urlChanged && !termsChanged) {
    await touchProductPrice(row, result.purchaseTerms);
    if (updatedProductMeasurement || row.hidden) {
      await revalidateProduct(row.productId);
    }
    console.log(`[IGNORE] ${result.shopName} ${logPrefix(row)}`);
    return;
  }

  if (priceAndLocationUnchanged && (urlChanged || termsChanged)) {
    await db
      .update(productsShopsPrices)
      .set({
        hidden: false,
        ...(urlChanged ? { url: canonicalUrl } : {}),
        ...termsPatch,
        updateAt: new Date(),
      })
      .where(
        and(
          eq(productsShopsPrices.productId, row.productId),
          eq(productsShopsPrices.shopId, row.shopId),
          or(
            ...(urlChanged
              ? [sql`${productsShopsPrices.url} IS DISTINCT FROM ${canonicalUrl}`]
              : []),
            ...(termsChanged
              ? [sql`TRUE`]
              : [])
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
              ? [sql`${productsShopsPrices.url} IS DISTINCT FROM ${canonicalUrl}`]
              : [])
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
    if (updatedProductMeasurement) {
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
