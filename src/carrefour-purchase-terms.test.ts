import assert from "node:assert/strict";
import test from "node:test";

import { extractCarrefourPurchaseTerms } from "./shops/carrefour.js";

test("treats explicit Carrefour package content as whole units", () => {
  const terms = extractCarrefourPurchaseTerms(
    {
      minPurchase: 1,
      maxPurchase: 10,
      itemName: "Frutas Del Bosque Vima Foods 450 G",
    },
    { presentation: "450 GR",}
  );

  assert.equal(terms?.mode, "unit");
  assert.equal(terms?.unit, "UND");
  assert.equal(terms?.minimum, "1");
  assert.equal(terms?.maximum, "10");
});

test("preserves Carrefour measured offer terms with normalized package content", () => {
  const terms = extractCarrefourPurchaseTerms(
    { minPurchase: 1, maxPurchase: 10, itemName: "Aji Morron Rojo" },
    { presentation: "1 LB", purchaseMode: "measure", purchaseUnit: "LB" }
  );

  assert.equal(terms?.mode, "measure");
  assert.equal(terms?.unit, "LB");
});

test("does not infer Carrefour terms without product unit evidence", () => {
  assert.equal(
    extractCarrefourPurchaseTerms(
      { minPurchase: 1, maxPurchase: 10, itemName: "Producto" },
      { presentation: null,}
    ),
    undefined
  );
});
