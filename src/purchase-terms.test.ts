import assert from "node:assert/strict";
import test from "node:test";

import { buildPurchaseTerms } from "./purchase-terms.js";
import { extractMagentoGraphqlPurchaseTerms } from "./shops/magento-graphql-purchase-terms.js";

test("normalizes exact fractional purchase terms", () => {
  assert.deepEqual(
    buildPurchaseTerms({
      mode: "measure",
      unit: "LIBRA",
      minimum: 1.5,
      increment: 0.5,
      maximum: 10,
      priceReferenceQuantity: 1,
      source: "fixture",
      evidence: { minimum: 1.5 },
    }),
    {
      mode: "measure",
      unit: "LB",
      minimum: "1.5",
      increment: "0.5",
      maximum: "10",
      priceReferenceQuantity: "1",
      source: "fixture",
      evidence: { minimum: 1.5 },
    }
  );
});

test("rejects incoherent exact terms", () => {
  assert.equal(
    buildPurchaseTerms({
      mode: "measure",
      unit: "LB",
      minimum: 2,
      increment: 1,
      maximum: 1,
      source: "fixture",
      evidence: {},
    }),
    undefined
  );
});

test("extracts exact Magento purchase terms from GraphQL", () => {
  const terms = extractMagentoGraphqlPurchaseTerms(
    {
      label_peso_variable: "lb",
      min_qty: 0.25,
      qty_increments: 0.25,
      custom_attributesV2: {
        items: [{ code: "peso_variable", value: "1" }],
      },
    },
    { source: "fixture_graphql" }
  );

  assert.equal(terms?.minimum, "0.25");
  assert.equal(terms?.increment, "0.25");
  assert.equal(terms?.maximum, null);
  assert.equal(terms?.unit, "LB");
  assert.equal(terms?.mode, "measure");
});

test("confirms standard Magento sale only from an explicit GraphQL flag", () => {
  const terms = extractMagentoGraphqlPurchaseTerms(
    {
      label_peso_variable: "lb",
      min_qty: 1,
      qty_increments: 1,
      custom_attributesV2: {
        items: [{ code: "peso_variable", value: "0" }],
      },
    },
    { source: "fixture_graphql" }
  );

  assert.equal(terms, null);
});

test("preserves previous Magento rules when GraphQL is ambiguous", () => {
  const terms = extractMagentoGraphqlPurchaseTerms(
    {
      label_peso_variable: "lb",
      min_qty: 1,
      qty_increments: 1,
      custom_attributesV2: {
        items: [],
      },
    },
    { source: "fixture_graphql" }
  );

  assert.equal(terms, undefined);
});

test("uses exact normalized product metadata for ambiguous Magento weight", () => {
  const terms = extractMagentoGraphqlPurchaseTerms(
    {
      label_peso_variable: "lb",
      min_qty: 1.85,
      qty_increments: 1.85,
      custom_attributesV2: {
        items: [],
      },
    },
    {
      source: "fixture_graphql",
      productUnit: {
        unit: "LB",
        baseUnit: "LB",
        baseUnitAmount: 1,
      },
    }
  );

  assert.equal(terms?.mode, "measure");
  assert.equal(terms?.unit, "LB");
  assert.equal(terms?.minimum, "1.85");
  assert.equal(terms?.increment, "1.85");
});

test("keeps ambiguous Magento package content as a whole unit", () => {
  const terms = extractMagentoGraphqlPurchaseTerms(
    {
      label_peso_variable: "lb",
      min_qty: 1,
      qty_increments: 1,
      custom_attributesV2: {
        items: [],
      },
    },
    {
      source: "fixture_graphql",
      productUnit: {
        unit: "8 OZ",
        baseUnit: "OZ",
        baseUnitAmount: 8,
      },
    }
  );

  assert.equal(terms, null);
});

test("preserves a non-standard unit minimum for an ambiguous Magento package", () => {
  const terms = extractMagentoGraphqlPurchaseTerms(
    {
      label_peso_variable: "lb",
      min_qty: 2,
      qty_increments: 2,
      custom_attributesV2: {
        items: [],
      },
    },
    {
      source: "fixture_graphql",
      productUnit: {
        unit: "8 OZ",
        baseUnit: "OZ",
        baseUnitAmount: 8,
      },
    }
  );

  assert.equal(terms?.mode, "unit");
  assert.equal(terms?.unit, "UND");
  assert.equal(terms?.minimum, "2");
  assert.equal(terms?.increment, "2");
});

test("preserves Magento rules when the API label conflicts with product metadata", () => {
  const terms = extractMagentoGraphqlPurchaseTerms(
    {
      label_peso_variable: "lb",
      min_qty: 1,
      qty_increments: 1,
      custom_attributesV2: {
        items: [],
      },
    },
    {
      source: "fixture_graphql",
      productUnit: {
        unit: "KG",
        baseUnit: "KG",
        baseUnitAmount: 1,
      },
    }
  );

  assert.equal(terms, undefined);
});
