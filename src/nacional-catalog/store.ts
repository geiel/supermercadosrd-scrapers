import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db/client.js";
import {
  nacionalCatalogSyncState,
  products,
  productsGlobalIds,
  productsShopsPrices,
} from "../db/schema.js";
import type {
  CatalogStateMap,
  ExistingNacionalReference,
  ExistingProductMatch,
  NacionalCatalogProduct,
  NacionalSitemapEntry,
  CatalogSyncStatus,
} from "./types.js";

export async function getCatalogStateMap(): Promise<CatalogStateMap> {
  const rows = await db
    .select()
    .from(nacionalCatalogSyncState)
    .orderBy(desc(nacionalCatalogSyncState.updatedAt));

  return new Map(rows.map((row) => [row.sku, row]));
}

export async function findExistingNacionalReferences(
  candidate: NacionalCatalogProduct
): Promise<ExistingNacionalReference[]> {
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
        eq(productsShopsPrices.shopId, 2),
        or(isNull(products.deleted), eq(products.deleted, false)),
        or(
          eq(productsShopsPrices.url, candidate.canonicalUrl),
          sql`substring(${productsShopsPrices.url} from '([0-9]{6,})(?:\\.html?)?$') = ${candidate.sku}`
        )
      )
    );

  const deduped = new Map<number, ExistingNacionalReference>();
  for (const row of rows) {
    if (!deduped.has(row.productId)) {
      deduped.set(row.productId, row);
    }
  }

  return Array.from(deduped.values());
}

export async function findGlobalIdMatches(
  eans: string[]
): Promise<ExistingProductMatch[]> {
  if (eans.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      productId: productsGlobalIds.productId,
      productName: products.name,
    })
    .from(productsGlobalIds)
    .innerJoin(products, eq(productsGlobalIds.productId, products.id))
    .where(
      and(
        inArray(productsGlobalIds.value, eans),
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
  entry: NacionalSitemapEntry;
  candidate?: NacionalCatalogProduct | null;
  syncStatus: CatalogSyncStatus;
  matchedProductId?: number | null;
  failureReason?: string | null;
  sourcePayload?: Record<string, unknown> | null;
}) {
  const now = new Date();

  await db
    .insert(nacionalCatalogSyncState)
    .values({
      sku: input.entry.sku,
      sitemapUrl: input.entry.sitemapUrl,
      canonicalUrl: input.candidate?.canonicalUrl ?? input.entry.canonicalUrl,
      sitemapLastmod: input.entry.lastmod,
      productName: input.candidate?.name ?? null,
      imageUrl: input.candidate?.imageUrl ?? null,
      eans: input.candidate?.eans ?? [],
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
      target: nacionalCatalogSyncState.sku,
      set: {
        sitemapUrl: input.entry.sitemapUrl,
        canonicalUrl: input.candidate?.canonicalUrl ?? input.entry.canonicalUrl,
        sitemapLastmod: input.entry.lastmod,
        productName: input.candidate?.name ?? null,
        imageUrl: input.candidate?.imageUrl ?? null,
        eans: input.candidate?.eans ?? [],
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
