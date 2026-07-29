import assert from "node:assert/strict";
import test from "node:test";

import { extractBravoPurchaseTerms } from "./shops/bravo-purchase-terms.js";

test("uses Bravo purchase type 1 for a whole packaged unit", () => {
  const terms = extractBravoPurchaseTerms(
    {
      idTipounidadArticulo: 1,
      mincantArticuloArticulo: 1,
      varcantArticuloArticulo: 1,
      maxcantArticuloArticulo: 30,
    },
    {
      unit: "225 GR",
      baseUnit: "GR",
      baseUnitAmount: 225,
    }
  );

  assert.equal(terms?.mode, "unit");
  assert.equal(terms?.unit, "UND");
  assert.equal(terms?.minimum, "1");
  assert.equal(terms?.increment, "1");
  assert.equal(terms?.maximum, "30");
});

test("uses Bravo purchase type 2 for measured products", () => {
  const terms = extractBravoPurchaseTerms(
    {
      idTipounidadArticulo: 2,
      mincantArticuloArticulo: 3,
      varcantArticuloArticulo: 3,
      maxcantArticuloArticulo: 30,
    },
    {
      unit: "LB",
      baseUnit: "LB",
      baseUnitAmount: 1,
    }
  );

  assert.equal(terms?.mode, "measure");
  assert.equal(terms?.unit, "LB");
  assert.equal(terms?.minimum, "3");
  assert.equal(terms?.increment, "3");
  assert.equal(terms?.maximum, "30");
});

test("preserves Bravo rules when the purchase type is missing", () => {
  const terms = extractBravoPurchaseTerms(
    {
      mincantArticuloArticulo: 1,
      varcantArticuloArticulo: 1,
      maxcantArticuloArticulo: 30,
    },
    {
      unit: "225 GR",
      baseUnit: "GR",
      baseUnitAmount: 225,
    }
  );

  assert.equal(terms, undefined);
});

test("preserves measured Bravo rules when the product unit is invalid", () => {
  const terms = extractBravoPurchaseTerms(
    {
      idTipounidadArticulo: 2,
      mincantArticuloArticulo: 1,
      varcantArticuloArticulo: 1,
      maxcantArticuloArticulo: 30,
    },
    {
      unit: "UND",
      baseUnit: "UND",
      baseUnitAmount: 1,
    }
  );

  assert.equal(terms, undefined);
});
