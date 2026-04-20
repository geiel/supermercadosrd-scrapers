import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  productShopRecoveryKeys,
  products,
  productsShopsPrices,
  sirenaCatalogSyncState,
} from "../db/schema.js";
import type {
  CatalogStateMap,
  CatalogSyncStatus,
  ExistingProductMatch,
  ExistingSirenaReference,
  SirenaCatalogCandidate,
} from "./types.js";

export async function getCatalogStateMap(): Promise<CatalogStateMap> {
  const rows = await db
    .select()
    .from(sirenaCatalogSyncState)
    .orderBy(desc(sirenaCatalogSyncState.updatedAt));

  return new Map(rows.map((row) => [row.productId, row]));
}

export async function findExistingSirenaReferences(
  candidate: SirenaCatalogCandidate
): Promise<ExistingSirenaReference[]> {
  const rows = await db
    .select({
      productId: productsShopsPrices.productId,
      productName: products.name,
      url: productsShopsPrices.url,
      api: productsShopsPrices.api,
      locationId: productsShopsPrices.locationId,
      currentPrice: productsShopsPrices.currentPrice,
      regularPrice: productsShopsPrices.regularPrice,
      updateAt: productsShopsPrices.updateAt,
      hidden: productsShopsPrices.hidden,
    })
    .from(productsShopsPrices)
    .innerJoin(products, eq(productsShopsPrices.productId, products.id))
    .where(
      and(
        eq(productsShopsPrices.shopId, 1),
        or(isNull(products.deleted), eq(products.deleted, false)),
        or(
          eq(productsShopsPrices.url, candidate.canonicalUrl),
          eq(productsShopsPrices.api, candidate.api),
          sql`substring(${productsShopsPrices.url} from '/products/index/([^/?#]+)') = ${candidate.friendlyUrl}`,
          sql`substring(${productsShopsPrices.url} from '/([^/?#]+)/p(?:[/?#]|$)') = ${candidate.friendlyUrl}`
        )
      )
    );

  const deduped = new Map<number, ExistingSirenaReference>();
  for (const row of rows) {
    if (!deduped.has(row.productId)) {
      deduped.set(row.productId, row);
    }
  }

  return Array.from(deduped.values());
}

export async function findSirenaRecoveryKeyMatches(
  productId: string
): Promise<ExistingProductMatch[]> {
  const rows = await db
    .select({
      productId: productShopRecoveryKeys.productId,
      productName: products.name,
    })
    .from(productShopRecoveryKeys)
    .innerJoin(products, eq(productShopRecoveryKeys.productId, products.id))
    .where(
      and(
        eq(productShopRecoveryKeys.shopId, 1),
        eq(productShopRecoveryKeys.externalIdType, "productid"),
        eq(productShopRecoveryKeys.externalId, productId),
        or(isNull(products.deleted), eq(products.deleted, false))
      )
    );

  const deduped = new Map<number, ExistingProductMatch>();
  for (const row of rows) {
    if (!deduped.has(row.productId)) {
      deduped.set(row.productId, row);
    }
  }

  return Array.from(deduped.values());
}

export async function upsertCatalogSyncState(input: {
  candidate: SirenaCatalogCandidate;
  syncStatus: CatalogSyncStatus;
  matchedProductId?: number | null;
  failureReason?: string | null;
  sourcePayload?: Record<string, unknown> | null;
}) {
  const now = new Date();

  await db
    .insert(sirenaCatalogSyncState)
    .values({
      productId: input.candidate.productId,
      friendlyUrl: input.candidate.friendlyUrl,
      canonicalUrl: input.candidate.canonicalUrl,
      api: input.candidate.api,
      sourceCategoryUrl: input.candidate.sourceCategoryUrl,
      categoryPath: input.candidate.categoryPath,
      topLevelCategorySlug: input.candidate.topLevelCategorySlug,
      productName: input.candidate.name,
      imageUrl: input.candidate.imageUrl,
      syncStatus: input.syncStatus,
      matchedProductId: input.matchedProductId ?? null,
      failureReason: input.failureReason ?? null,
      sourcePayload: input.sourcePayload ?? null,
      lastSeenAt: now,
      lastProcessedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sirenaCatalogSyncState.productId,
      set: {
        friendlyUrl: input.candidate.friendlyUrl,
        canonicalUrl: input.candidate.canonicalUrl,
        api: input.candidate.api,
        sourceCategoryUrl: input.candidate.sourceCategoryUrl,
        categoryPath: input.candidate.categoryPath,
        topLevelCategorySlug: input.candidate.topLevelCategorySlug,
        productName: input.candidate.name,
        imageUrl: input.candidate.imageUrl,
        syncStatus: input.syncStatus,
        matchedProductId: input.matchedProductId ?? null,
        failureReason: input.failureReason ?? null,
        sourcePayload: input.sourcePayload ?? null,
        lastSeenAt: now,
        lastProcessedAt: now,
        updatedAt: now,
      },
    });
}
