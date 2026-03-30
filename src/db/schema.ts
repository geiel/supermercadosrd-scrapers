import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: integer("id").primaryKey(),
  name: text("name"),
  image: text("image"),
  deleted: boolean("deleted"),
});

export const productsGlobalIds = pgTable("products_global_ids", {
  id: integer("id").primaryKey(),
  productId: integer("productId").notNull(),
  sourceShopId: integer("sourceShopId").notNull(),
  type: text("type").notNull(),
  value: text("value").notNull(),
  rawValue: text("rawValue").notNull(),
  sourceRef: text("sourceRef"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

export const productImages = pgTable(
  "product_images",
  {
    productId: integer("productId").notNull(),
    imageUrl: text("imageUrl").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    primary: boolean("primary").notNull().default(false),
  },
  (table) => [
    primaryKey({
      columns: [table.productId, table.imageUrl],
      name: "product_images_productId_imageUrl_pk",
    }),
  ]
);

export const productBrokenImages = pgTable("product_broken_images", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("productId").notNull(),
  imageUrl: text("imageUrl").notNull(),
  reportedAt: timestamp("reportedAt", { withTimezone: true }).notNull(),
  isFixed: boolean("isFixed").default(false),
});

export const productImageUpdateReports = pgTable("product_image_update_reports", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("productId").notNull(),
  beforeImageUrl: text("beforeImageUrl").notNull(),
  afterImageUrl: text("afterImageUrl").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
});

export const productsShopsPrices = pgTable(
  "products_shops_prices",
  {
    productId: integer("productId").notNull(),
    shopId: integer("shopId").notNull(),
    url: text("url").notNull(),
    api: text("api"),
    locationId: text("locationId"),
    currentPrice: numeric("currentPrice"),
    regularPrice: numeric("regularPrice"),
    updateAt: timestamp("updateAt", { withTimezone: true }),
    hidden: boolean("hidden"),
  },
  (table) => [
    primaryKey({
      columns: [table.productId, table.shopId],
      name: "products_shops_prices_productId_shopId_pk",
    }),
  ]
);

export const productsPricesHistory = pgTable("products_prices_history", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("productId").notNull(),
  shopId: integer("shopId").notNull(),
  price: numeric("price").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
});

export const todaysDeals = pgTable("todays_deals", {
  productId: integer("productId").primaryKey(),
});

export const productShopRecoveryKeys = pgTable(
  "product_shop_recovery_keys",
  {
    productId: integer("productId").notNull(),
    shopId: integer("shopId").notNull(),
    externalIdType: text("externalIdType").notNull(),
    externalId: text("externalId").notNull(),
    source: text("source").notNull(),
    discoveredAt: timestamp("discoveredAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastVerifiedAt: timestamp("lastVerifiedAt", { withTimezone: true }),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.productId, table.shopId],
      name: "product_shop_recovery_keys_productId_shopId_pk",
    }),
  ]
);

export const productShopRecoveryReviews = pgTable(
  "product_shop_recovery_reviews",
  {
    productId: integer("productId").notNull(),
    shopId: integer("shopId").notNull(),
    productName: text("productName"),
    shopName: text("shopName").notNull(),
    currentUrl: text("currentUrl").notNull(),
    currentApi: text("currentApi"),
    currentLocationId: text("currentLocationId"),
    currentStoredPrice: numeric("currentStoredPrice"),
    currentStoredRegularPrice: numeric("currentStoredRegularPrice"),
    currentHidden: boolean("currentHidden"),
    externalIdType: text("externalIdType"),
    externalId: text("externalId"),
    keySource: text("keySource"),
    recoveryMethod: text("recoveryMethod"),
    proposalStatus: text("proposalStatus"),
    verificationStatus: text("verificationStatus").notNull(),
    proposedUrl: text("proposedUrl"),
    proposedApi: text("proposedApi"),
    proposedLocationId: text("proposedLocationId"),
    proposedCurrentPrice: numeric("proposedCurrentPrice"),
    proposedRegularPrice: numeric("proposedRegularPrice"),
    proposedHidden: boolean("proposedHidden"),
    proposalEvidence: jsonb("proposalEvidence"),
    failureReason: text("failureReason"),
    lastAttemptStatus: text("lastAttemptStatus").notNull(),
    lastAttemptReason: text("lastAttemptReason"),
    lastAttemptEvidence: jsonb("lastAttemptEvidence"),
    lastAttemptedAt: timestamp("lastAttemptedAt", { withTimezone: true }).notNull(),
    reviewedAt: timestamp("reviewedAt", { withTimezone: true }),
    reviewNote: text("reviewNote"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.productId, table.shopId],
      name: "product_shop_recovery_reviews_productId_shopId_pk",
    }),
  ]
);

export const nacionalCatalogSyncState = pgTable("nacional_catalog_sync_state", {
  sku: text("sku").primaryKey(),
  sitemapUrl: text("sitemapUrl").notNull(),
  canonicalUrl: text("canonicalUrl").notNull(),
  sitemapLastmod: timestamp("sitemapLastmod", { withTimezone: true }),
  productName: text("productName"),
  imageUrl: text("imageUrl"),
  eans: jsonb("eans"),
  syncStatus: text("syncStatus").notNull(),
  matchedProductId: integer("matchedProductId"),
  failureReason: text("failureReason"),
  sourcePayload: jsonb("sourcePayload"),
  lastSeenAt: timestamp("lastSeenAt", { withTimezone: true }).notNull().defaultNow(),
  lastProcessedAt: timestamp("lastProcessedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
});

export type ProductShopPriceRow = typeof productsShopsPrices.$inferSelect;
export type ProductBrokenImageRow = typeof productBrokenImages.$inferSelect;
export type ProductImageRow = typeof productImages.$inferSelect;
export type ProductImageUpdateReportRow = typeof productImageUpdateReports.$inferSelect;
export type ProductShopRecoveryKeyRow = typeof productShopRecoveryKeys.$inferSelect;
export type ProductShopRecoveryReviewRow =
  typeof productShopRecoveryReviews.$inferSelect;
export type NacionalCatalogSyncStateRow =
  typeof nacionalCatalogSyncState.$inferSelect;
