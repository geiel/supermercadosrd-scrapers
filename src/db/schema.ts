import { boolean, integer, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: integer("id").primaryKey(),
  name: text("name"),
  image: text("image"),
  deleted: boolean("deleted"),
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

export type ProductShopPriceRow = typeof productsShopsPrices.$inferSelect;
export type ProductBrokenImageRow = typeof productBrokenImages.$inferSelect;
export type ProductImageRow = typeof productImages.$inferSelect;
export type ProductImageUpdateReportRow = typeof productImageUpdateReports.$inferSelect;
