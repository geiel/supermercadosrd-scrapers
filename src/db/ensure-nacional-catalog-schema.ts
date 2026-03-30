import { postgresClient } from "./client.js";

export async function ensureNacionalCatalogSchema(): Promise<void> {
  await postgresClient`
    create table if not exists nacional_catalog_sync_state (
      sku text primary key,
      "sitemapUrl" text not null,
      "canonicalUrl" text not null,
      "sitemapLastmod" timestamptz,
      "productName" text,
      "imageUrl" text,
      eans jsonb,
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
    create index if not exists nacional_catalog_sync_state_syncStatus_updatedAt_idx
    on nacional_catalog_sync_state ("syncStatus", "updatedAt" desc)
  `;

  await postgresClient`
    create index if not exists nacional_catalog_sync_state_lastProcessedAt_idx
    on nacional_catalog_sync_state ("lastProcessedAt" desc)
  `;

  await postgresClient`
    create index if not exists nacional_catalog_sync_state_matchedProductId_idx
    on nacional_catalog_sync_state ("matchedProductId")
  `;
}
