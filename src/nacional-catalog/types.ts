import type { NacionalCatalogSyncStateRow } from "../db/schema.js";

export type NacionalSitemapEntry = {
  sku: string;
  sitemapUrl: string;
  canonicalUrl: string;
  lastmod: Date | null;
};

export type NacionalCatalogProduct = {
  sku: string;
  name: string;
  canonicalUrl: string;
  imageUrl: string | null;
  eans: string[];
  rawAttributes: Record<string, unknown>;
};

export type ExistingNacionalReference = {
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
      matchStrategy: "existing_reference";
      liveReference: ExistingNacionalReference;
    }
  | {
      kind: "proposal_target";
      matchedProductId: number;
      matchStrategy: "existing_reference" | "barcode";
      liveReference: ExistingNacionalReference | null;
    }
  | {
      kind:
        | "ambiguous_existing_reference"
        | "ambiguous_global_id_match"
        | "conflicting_match_signals"
        | "unmatched_catalog_product";
      reason: string;
      evidence: Record<string, unknown>;
    };

export type CatalogSyncStatus =
  | "proposal_ready"
  | "no_reference_change"
  | "verification_failed"
  | "invalid_catalog_url"
  | "ambiguous_existing_reference"
  | "ambiguous_global_id_match"
  | "conflicting_match_signals"
  | "unmatched_catalog_product"
  | "rest_product_missing";

export type CatalogStateMap = Map<string, NacionalCatalogSyncStateRow>;
