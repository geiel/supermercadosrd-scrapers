import assert from "node:assert/strict";
import test from "node:test";

import { buildPurchaseTerms } from "./purchase-terms.js";
import { extractMagentoPurchaseTerms } from "./shops/magento-purchase-terms.js";

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

test("extracts Magento cart rules from embedded configuration", () => {
  const terms = extractMagentoPurchaseTerms(
    `window.config = {"minAllowed":1.5,"maxAllowed":12,"qtyIncrements":0.5,"pesoVariable":true};`,
    { unit: "LB", source: "fixture_page" }
  );

  assert.equal(terms?.minimum, "1.5");
  assert.equal(terms?.increment, "0.5");
  assert.equal(terms?.maximum, "12");
  assert.equal(terms?.mode, "measure");
});
