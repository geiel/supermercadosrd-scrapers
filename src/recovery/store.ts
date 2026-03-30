import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  productShopRecoveryKeys,
  productShopRecoveryReviews,
  type ProductShopRecoveryReviewRow,
} from "../db/schema.js";
import { SHOP_NAMES } from "../result.js";
import type {
  HiddenProductRecoveryRow,
  RecoveryAttempt,
  RecoveryKey,
} from "./types.js";

function hasVerifiedProposal(review: ProductShopRecoveryReviewRow | null): boolean {
  return (
    review?.verificationStatus === "verified" &&
    review.proposalStatus !== null &&
    (review.proposedUrl !== null || review.proposedApi !== null)
  );
}

async function getExistingReview(
  productId: number,
  shopId: number
): Promise<ProductShopRecoveryReviewRow | null> {
  const rows = await db
    .select()
    .from(productShopRecoveryReviews)
    .where(
      and(
        eq(productShopRecoveryReviews.productId, productId),
        eq(productShopRecoveryReviews.shopId, shopId)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function upsertRecoveryKey(
  row: HiddenProductRecoveryRow,
  key: RecoveryKey,
  {
    verifiedAt,
  }: {
    verifiedAt?: Date;
  } = {}
): Promise<void> {
  const now = new Date();

  await db
    .insert(productShopRecoveryKeys)
    .values({
      productId: row.productId,
      shopId: row.shopId,
      externalIdType: key.externalIdType,
      externalId: key.externalId,
      source: key.source,
      discoveredAt: now,
      lastVerifiedAt: verifiedAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [productShopRecoveryKeys.productId, productShopRecoveryKeys.shopId],
      set: {
        externalIdType: key.externalIdType,
        externalId: key.externalId,
        source: key.source,
        ...(verifiedAt ? { lastVerifiedAt: verifiedAt } : {}),
        updatedAt: now,
      },
    });
}

export async function upsertRecoveryReview(
  row: HiddenProductRecoveryRow,
  key: RecoveryKey | null,
  attempt: RecoveryAttempt
): Promise<void> {
  const now = new Date();
  const existing = await getExistingReview(row.productId, row.shopId);
  const baseValues = {
    productId: row.productId,
    shopId: row.shopId,
    productName: row.productName,
    shopName: SHOP_NAMES[row.shopId],
    currentUrl: row.url,
    currentApi: row.api,
    currentLocationId: row.locationId,
    currentStoredPrice: row.currentPrice,
    currentStoredRegularPrice: row.regularPrice,
    currentHidden: row.hidden,
    externalIdType:
      key?.externalIdType ??
      (attempt.status === "verified"
        ? attempt.proposal.externalIdType
        : attempt.externalIdType),
    externalId:
      key?.externalId ??
      (attempt.status === "verified"
        ? attempt.proposal.externalId
        : attempt.externalId),
    keySource: key?.source ?? existing?.keySource ?? null,
    recoveryMethod:
      attempt.status === "verified"
        ? attempt.proposal.recoveryMethod
        : attempt.recoveryMethod,
    lastAttemptStatus: attempt.status === "verified" ? "verified" : "failed",
    lastAttemptReason: attempt.status === "verified" ? null : attempt.reason,
    lastAttemptEvidence:
      attempt.status === "verified" ? attempt.proposal.evidence : attempt.evidence,
    lastAttemptedAt: now,
    updatedAt: now,
  };

  const nextValues =
    attempt.status === "verified"
      ? {
          ...baseValues,
          proposalStatus: "pending_review",
          verificationStatus: "verified",
          proposedUrl: attempt.proposal.proposedUrl,
          proposedApi: attempt.proposal.proposedApi,
          proposedLocationId: attempt.proposal.proposedLocationId,
          proposedCurrentPrice: attempt.proposal.proposedCurrentPrice,
          proposedRegularPrice: attempt.proposal.proposedRegularPrice,
          proposedHidden: false,
          proposalEvidence: attempt.proposal.evidence,
          failureReason: null,
          reviewedAt: null,
          reviewNote: null,
        }
      : hasVerifiedProposal(existing)
        ? {
            ...baseValues,
            proposalStatus: existing?.proposalStatus ?? null,
            verificationStatus: existing?.verificationStatus ?? "verified",
            proposedUrl: existing?.proposedUrl ?? null,
            proposedApi: existing?.proposedApi ?? null,
            proposedLocationId: existing?.proposedLocationId ?? null,
            proposedCurrentPrice: existing?.proposedCurrentPrice ?? null,
            proposedRegularPrice: existing?.proposedRegularPrice ?? null,
            proposedHidden: existing?.proposedHidden ?? null,
            proposalEvidence: existing?.proposalEvidence ?? null,
            failureReason: existing?.failureReason ?? null,
            reviewedAt: existing?.reviewedAt ?? null,
            reviewNote: existing?.reviewNote ?? null,
          }
        : {
            ...baseValues,
            proposalStatus: null,
            verificationStatus: "failed",
            proposedUrl: null,
            proposedApi: null,
            proposedLocationId: null,
            proposedCurrentPrice: null,
            proposedRegularPrice: null,
            proposedHidden: null,
            proposalEvidence: null,
            failureReason: attempt.reason,
            reviewedAt: null,
            reviewNote: null,
          };

  await db
    .insert(productShopRecoveryReviews)
    .values({
      ...nextValues,
      createdAt: existing?.createdAt ?? now,
    })
    .onConflictDoUpdate({
      target: [
        productShopRecoveryReviews.productId,
        productShopRecoveryReviews.shopId,
      ],
      set: nextValues,
    });
}
