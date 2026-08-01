import assert from "node:assert/strict";
import test from "node:test";

import {
  extractGarridoPurchaseTerms,
  resolveGarridoPurchaseUnit,
} from "./shops/garrido.js";

test("falls back from blank Garrido subUnit to the API unit", () => {
  assert.equal(
    resolveGarridoPurchaseUnit({
      subUnit: "",
      unit: "LB",
      productUnit: "LB",
      baseUnit: "LB",
      baseUnitAmount: 1,
    }),
    "LB"
  );
});

test("uses a fractional Garrido click multiplier as the measured increment", () => {
  const terms = extractGarridoPurchaseTerms(
    {
      unit: "LB",
      subUnit: "",
      subQty: 0,
      minQty: 0,
      maxQty: 10,
      clickMultiplier: 0.5,
    },
    { unit: "LB", baseUnit: "LB", baseUnitAmount: 1 }
  );

  assert.equal(terms?.mode, "measure");
  assert.equal(terms?.unit, "LB");
  assert.equal(terms?.minimum, "0.5");
  assert.equal(terms?.increment, "0.5");
  assert.equal(terms?.priceReferenceQuantity, "1");
});

test("keeps Garrido package SKUs as whole units", () => {
  const terms = extractGarridoPurchaseTerms(
    {
      unit: "UN",
      subUnit: "",
      subQty: 1,
      minQty: 0,
      maxQty: 50,
      clickMultiplier: 1,
    },
    { unit: "450 GR", baseUnit: "GR", baseUnitAmount: 450 }
  );

  assert.equal(terms?.mode, "unit");
  assert.equal(terms?.unit, "UND");
  assert.equal(terms?.minimum, "1");
});

test("does not trust a Garrido weight unit that conflicts with the product", () => {
  const terms = extractGarridoPurchaseTerms(
    {
      unit: "LB",
      subUnit: "",
      subQty: 0,
      minQty: 0,
      maxQty: 10,
      clickMultiplier: 0.5,
    },
    { unit: "7 OZ", baseUnit: "OZ", baseUnitAmount: 7 }
  );

  assert.equal(terms, null);
});
