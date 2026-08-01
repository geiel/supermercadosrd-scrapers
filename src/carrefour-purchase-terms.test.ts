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
    { unit: "450 GR", baseUnit: "GR", baseUnitAmount: 450 }
  );

  assert.equal(terms?.mode, "unit");
  assert.equal(terms?.unit, "UND");
  assert.equal(terms?.minimum, "1");
  assert.equal(terms?.maximum, "10");
});

test("keeps a bare Carrefour weight unit as measured sale", () => {
  const terms = extractCarrefourPurchaseTerms(
    { minPurchase: 1, maxPurchase: 10, itemName: "Aji Morron Rojo" },
    { unit: "LB", baseUnit: "LB", baseUnitAmount: 1 }
  );

  assert.equal(terms?.mode, "measure");
  assert.equal(terms?.unit, "LB");
});

test("does not infer Carrefour terms without product unit evidence", () => {
  assert.equal(
    extractCarrefourPurchaseTerms(
      { minPurchase: 1, maxPurchase: 10, itemName: "Producto" },
      { unit: null, baseUnit: null, baseUnitAmount: null }
    ),
    undefined
  );
});
