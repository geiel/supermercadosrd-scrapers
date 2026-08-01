import assert from "node:assert/strict";
import test from "node:test";

import {
  extractSirenaLegacyPurchaseTerms,
  extractSirenaVtexPurchaseTerms,
} from "./shops/sirena-purchase-terms.js";

test("treats an explicit legacy package size as a whole unit", () => {
  const terms = extractSirenaLegacyPurchaseTerms(
    {
      minimum: "1.00",
      producttype_step: "1.00",
      producttype_decimal: 0,
    },
    {
      unit: "16 OZ",
      baseUnit: "OZ",
      baseUnitAmount: "16",
    }
  );

  assert.equal(terms, null);
});

test("treats an explicit one-pound legacy package as a whole unit", () => {
  const terms = extractSirenaLegacyPurchaseTerms(
    {
      minimum: "1.00",
      producttype_step: "1.00",
      producttype_decimal: 0,
    },
    {
      unit: "1 LB",
      baseUnit: "LB",
      baseUnitAmount: "1",
    }
  );

  assert.equal(terms, null);
});

test("recognizes positive legacy decimal precision as measured sale", () => {
  const terms = extractSirenaLegacyPurchaseTerms(
    {
      minimum: "1.00",
      producttype_step: "1.00",
      producttype_decimal: 2,
    },
    {
      unit: "LB",
      baseUnit: "LB",
      baseUnitAmount: "1",
    }
  );

  assert.equal(terms?.mode, "measure");
  assert.equal(terms?.unit, "LB");
  assert.equal(terms?.minimum, "1");
  assert.equal(terms?.increment, "1");
});

test("preserves legacy rules when decimal support is missing", () => {
  const terms = extractSirenaLegacyPurchaseTerms(
    {
      minimum: "1.00",
      producttype_step: "1.00",
    },
    {
      unit: "16 OZ",
      baseUnit: "OZ",
      baseUnitAmount: "16",
    }
  );

  assert.equal(terms, undefined);
});

test("confirms a whole-unit VTEX product", () => {
  const terms = extractSirenaVtexPurchaseTerms({
    measurementUnit: "un",
    unitMultiplier: 1,
  });

  assert.equal(terms, null);
});

test("uses the VTEX multiplier as the measured purchase increment", () => {
  const terms = extractSirenaVtexPurchaseTerms({
    measurementUnit: "lb",
    unitMultiplier: 0.5,
  });

  assert.equal(terms?.mode, "measure");
  assert.equal(terms?.unit, "LB");
  assert.equal(terms?.minimum, "0.5");
  assert.equal(terms?.increment, "0.5");
  assert.equal(terms?.priceReferenceQuantity, "1");
});

test("corrects an extreme VTEX multiplier from the explicit item label", () => {
  const terms = extractSirenaVtexPurchaseTerms(
    {
      measurementUnit: "lb",
      unitMultiplier: 100,
      itemNameComplete: "Salchicha Sucarne Parrillera Lb 1 LB",
    },
    {
      unit: "LB",
      baseUnit: "LB",
      baseUnitAmount: 1,
    }
  );

  assert.equal(terms?.mode, "measure");
  assert.equal(terms?.unit, "LB");
  assert.equal(terms?.minimum, "1");
  assert.equal(terms?.increment, "1");
  assert.equal(terms?.evidence.correctedUnitMultiplier, 1);
});

test("uses the VTEX item label to reject a false measured package", () => {
  const terms = extractSirenaVtexPurchaseTerms(
    {
      measurementUnit: "lb",
      unitMultiplier: 0.5,
      itemNameComplete: "Queso Shredded Mozzarella 7 Oz 1 Und.",
    },
    {
      unit: "7 OZ",
      baseUnit: "OZ",
      baseUnitAmount: 7,
    }
  );

  assert.equal(terms, null);
});
