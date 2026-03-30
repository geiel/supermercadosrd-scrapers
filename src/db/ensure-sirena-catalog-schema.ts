import { postgresClient } from "./client.js";

export async function ensureSirenaCatalogSchema(): Promise<void> {
  await postgresClient`
    create table if not exists sirena_catalog_sync_state (
      "productId" text primary key,
      "friendlyUrl" text not null,
      "canonicalUrl" text not null,
      api text not null,
      "sourceCategoryUrl" text not null,
      "categoryPath" text,
      "topLevelCategorySlug" text not null,
      "productName" text,
      "imageUrl" text,
      "syncStatus" text not null,
      "matchedProductId" integer,
      "failureReason" text,
      "sourcePayload" jsonb,
      "lastSeenAt" timestamptz not null default now(),
      "lastProcessedAt" timestamptz,
      "createdAt" timestamptz not null default now(),
      "updatedAt" timestamptz not null default now()
    )
  `;

  await postgresClient`
    create index if not exists sirena_catalog_sync_state_syncStatus_updatedAt_idx
    on sirena_catalog_sync_state ("syncStatus", "updatedAt" desc)
  `;

  await postgresClient`
    create index if not exists sirena_catalog_sync_state_lastProcessedAt_idx
    on sirena_catalog_sync_state ("lastProcessedAt" desc)
  `;

  await postgresClient`
    create index if not exists sirena_catalog_sync_state_matchedProductId_idx
    on sirena_catalog_sync_state ("matchedProductId")
  `;
}
