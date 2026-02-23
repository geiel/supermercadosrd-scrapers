import { boolean, integer, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: integer("id").primaryKey(),
  deleted: boolean("deleted"),
});

export const productsShopsPrices = pgTable(
  "products_shops_prices",
  {
    productId: integer("productId").notNull(),
    shopId: integer("shopId").notNull(),
    url: text("url").notNull(),
    api: text("api"),
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
