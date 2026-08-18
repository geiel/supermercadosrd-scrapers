import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPedidosYaCategories,
  normalizePedidosYaProduct,
} from "./catalog.js";

test("extractPedidosYaCategories walks the category tree", () => {
  const categories = extractPedidosYaCategories({
    type: "TREE",
    categories: [
      {
        global_id: "parent",
        name: "Abarrotes",
        children: [
          { global_id: "coffee", name: "Café", children: [] },
        ],
      },
    ],
  });

  assert.deepEqual(categories, [
    { id: "parent", name: "Abarrotes" },
    { id: "coffee", name: "Café" },
  ]);
});

test("normalizePedidosYaProduct preserves price identity and evidence", () => {
  const raw = {
    id: "123",
    name: "Café Santo Domingo Molido 226.8 g",
    description: "Café molido",
    campaigns: [{ id: "promo" }],
    pricing: {
      price: 218,
      originalPrice: 230,
      pricePerMeasurementUnit: 0.96,
    },
    absoluteImages: ["https://example.test/product.jpg"],
    gtin: "7460000000000",
    integrationCode: "ABC",
    legacyId: "99",
    maxQuantity: 10,
    requiresAgeCheck: false,
    stock: { available: true },
    tags: ["coffee"],
  };
  const product = normalizePedidosYaProduct(raw, {
    id: "coffee",
    name: "Café",
  });

  assert.ok(product);
  assert.equal(product.externalId, "123");
  assert.equal(product.currentPrice, 218);
  assert.equal(product.regularPrice, 230);
  assert.equal(product.gtin, "7460000000000");
  assert.deepEqual(product.categoryIds, ["coffee"]);
  assert.equal(product.raw, raw);
});

