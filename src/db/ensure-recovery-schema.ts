import { postgresClient } from "./client.js";

export async function ensureRecoverySchema(): Promise<void> {
  await postgresClient`
    create table if not exists product_shop_recovery_keys (
      "productId" integer not null,
      "shopId" integer not null,
      "externalIdType" text not null,
      "externalId" text not null,
      source text not null,
      "discoveredAt" timestamptz not null default now(),
      "lastVerifiedAt" timestamptz,
      "updatedAt" timestamptz not null default now(),
      primary key ("productId", "shopId")
    )
  `;

  await postgresClient`
    create table if not exists product_shop_recovery_reviews (
      "productId" integer not null,
      "shopId" integer not null,
      "productName" text,
      "shopName" text not null,
      "currentUrl" text not null,
      "currentApi" text,
      "currentLocationId" text,
      "currentStoredPrice" numeric,
      "currentStoredRegularPrice" numeric,
      "currentHidden" boolean,
      "externalIdType" text,
      "externalId" text,
      "keySource" text,
      "recoveryMethod" text,
      "proposalStatus" text,
      "verificationStatus" text not null,
      "proposedUrl" text,
      "proposedApi" text,
      "proposedLocationId" text,
      "proposedCurrentPrice" numeric,
      "proposedRegularPrice" numeric,
      "proposedHidden" boolean,
      "proposalEvidence" jsonb,
      "failureReason" text,
      "lastAttemptStatus" text not null,
      "lastAttemptReason" text,
      "lastAttemptEvidence" jsonb,
      "lastAttemptedAt" timestamptz not null,
      "reviewedAt" timestamptz,
      "reviewNote" text,
      "createdAt" timestamptz not null default now(),
      "updatedAt" timestamptz not null default now(),
      primary key ("productId", "shopId")
    )
  `;

  await postgresClient`
    create index if not exists product_shop_recovery_keys_shopId_updatedAt_idx
    on product_shop_recovery_keys ("shopId", "updatedAt" desc)
  `;

  await postgresClient`
    create index if not exists product_shop_recovery_reviews_proposalStatus_updatedAt_idx
    on product_shop_recovery_reviews ("proposalStatus", "updatedAt" desc)
  `;

  await postgresClient`
    create index if not exists product_shop_recovery_reviews_lastAttemptedAt_idx
    on product_shop_recovery_reviews ("lastAttemptedAt" desc)
  `;
}
