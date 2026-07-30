import assert from "node:assert/strict";
import test from "node:test";

import { resolvePlazaLamaPurchaseUnit } from "./shops/plaza-lama.js";

test("uses Plaza Lama unit when subUnit is blank", () => {
  assert.equal(
    resolvePlazaLamaPurchaseUnit({
      subUnit: "",
      unit: "LB",
      baseUnit: "LB",
      productUnit: "LB",
    }),
    "LB"
  );
});

test("prefers a non-empty Plaza Lama subUnit", () => {
  assert.equal(
    resolvePlazaLamaPurchaseUnit({
      subUnit: "UND",
      unit: "LB",
      baseUnit: "LB",
      productUnit: "LB",
    }),
    "UND"
  );
});

test("falls back to normalized product metadata", () => {
  assert.equal(
    resolvePlazaLamaPurchaseUnit({
      subUnit: " ",
      unit: null,
      baseUnit: "LIBRA",
      productUnit: "LB",
    }),
    "LB"
  );
});
