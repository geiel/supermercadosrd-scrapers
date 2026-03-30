import type { SirenaCatalogSyncStateRow } from "../db/schema.js";

export type SirenaCategoryNode = {
  id: string;
  name: string;
  friendlyUrl: string;
  imageUrl: string | null;
  children: SirenaCategoryNode[];
};

export type SirenaTopLevelCategory = {
  name: string;
  friendlyUrl: string;
  imageUrl: string | null;
};

export type SirenaCategoryPageProduct = {
  productId: string;
  friendlyUrl: string;
  name: string;
  categoryName: string | null;
  imageUrl: string | null;
};

export type SirenaCatalogCandidate = {
  productId: string;
  friendlyUrl: string;
  canonicalUrl: string;
  api: string;
  sourceCategoryUrl: string;
  topLevelCategorySlug: string;
  categoryPath: string;
  name: string;
  imageUrl: string | null;
  ignoredByCategoryRule: boolean;
};

export type ExistingSirenaReference = {
  productId: number;
  productName: string | null;
  url: string;
  api: string | null;
  locationId: string | null;
  currentPrice: string | null;
  regularPrice: string | null;
  updateAt: Date | null;
  hidden: boolean | null;
};

export type ExistingProductMatch = {
  productId: number;
  productName: string | null;
};

export type MatchResolution =
  | {
      kind: "no_reference_change";
      matchedProductId: number;
      matchStrategy: "existing_reference" | "recovery_key";
      liveReference: ExistingSirenaReference | null;
    }
  | {
      kind: "proposal_target";
      matchedProductId: number;
      matchStrategy: "existing_reference" | "recovery_key";
      liveReference: ExistingSirenaReference | null;
    }
  | {
      kind:
        | "ambiguous_existing_reference"
        | "ambiguous_recovery_key_match"
        | "conflicting_match_signals"
        | "unmatched_catalog_product";
      reason: string;
      evidence: Record<string, unknown>;
    };

export type CatalogSyncStatus =
  | "proposal_ready"
  | "no_reference_change"
  | "verification_failed"
  | "ambiguous_existing_reference"
  | "ambiguous_recovery_key_match"
  | "conflicting_match_signals"
  | "unmatched_catalog_product"
  | "ignored_by_category_rule";

export type CatalogStateMap = Map<string, SirenaCatalogSyncStateRow>;
