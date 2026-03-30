import type { ShopId } from "../types.js";

export type RecoverableShopId = 2 | 3 | 4;

export type RecoveryExternalIdType = "sku" | "url_tail";

export type RecoveryMethod =
  | "nacional_sku_lookup"
  | "nacional_catalog_sitemap"
  | "jumbo_url_tail_search"
  | "plaza_lama_sku_lookup";

export type RecoveryKey = {
  externalIdType: RecoveryExternalIdType;
  externalId: string;
  source: string;
};

export type HiddenProductRecoveryRow = {
  productId: number;
  productName: string | null;
  shopId: RecoverableShopId;
  url: string;
  api: string | null;
  locationId: string | null;
  currentPrice: string | null;
  regularPrice: string | null;
  updateAt: Date | null;
  hidden: boolean | null;
};

export type RecoveryProposal = {
  recoveryMethod: RecoveryMethod;
  externalIdType: RecoveryExternalIdType;
  externalId: string;
  proposedUrl: string;
  proposedApi: string | null;
  proposedLocationId: string | null;
  proposedCurrentPrice: string;
  proposedRegularPrice: string | null;
  evidence: Record<string, unknown>;
};

export type RecoveryFailure = {
  status: "failed";
  recoveryMethod: RecoveryMethod | null;
  externalIdType: RecoveryExternalIdType | null;
  externalId: string | null;
  reason: string;
  evidence: Record<string, unknown>;
};

export type RecoverySuccess = {
  status: "verified";
  proposal: RecoveryProposal;
};

export type RecoveryAttempt = RecoveryFailure | RecoverySuccess;

export function isRecoverableShopId(shopId: ShopId): shopId is RecoverableShopId {
  return shopId === 2 || shopId === 3 || shopId === 4;
}
