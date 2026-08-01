import assert from "node:assert/strict";
import test from "node:test";

import {
  getProductPriceHistoryCaptureType,
  productPriceStatesEqual,
} from "./product-price-history.js";

test("compares equivalent numeric price representations", () => {
  assert.equal(
    productPriceStatesEqual(
      { price: "100.00", regularPrice: "125" },
      { price: 100, regularPrice: "125.0" }
    ),
    true
  );
});

test("detects current and regular price changes independently", () => {
  assert.equal(
    productPriceStatesEqual(
      { price: "100", regularPrice: "125" },
      { price: "90", regularPrice: "125" }
    ),
    false
  );
  assert.equal(
    productPriceStatesEqual(
      { price: "90", regularPrice: "125" },
      { price: "90", regularPrice: "130" }
    ),
    false
  );
});

test("detects promotion start and end at an unchanged selling price", () => {
  assert.equal(
    productPriceStatesEqual(
      { price: "90", regularPrice: null },
      { price: "90", regularPrice: "125" }
    ),
    false
  );
  assert.equal(
    productPriceStatesEqual(
      { price: "90", regularPrice: "125" },
      { price: "90", regularPrice: null }
    ),
    false
  );
});

test("classifies the first complete observation and subsequent changes", () => {
  assert.equal(
    getProductPriceHistoryCaptureType(
      {
        price: "90",
        regularPrice: null,
        captureType: "legacy_price_only",
      },
      { price: "90", regularPrice: "125" }
    ),
    "initial_snapshot"
  );

  const reliable = {
    price: "90",
    regularPrice: "125",
    captureType: "initial_snapshot" as const,
  };
  assert.equal(
    getProductPriceHistoryCaptureType(reliable, {
      price: "90.0",
      regularPrice: "125.00",
    }),
    null
  );
  assert.equal(
    getProductPriceHistoryCaptureType(reliable, {
      price: "90",
      regularPrice: null,
    }),
    "state_change"
  );
});
