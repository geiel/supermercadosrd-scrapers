import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOfferLocationValues,
  classifyScrapeWrite,
  diffOfferLocations,
  partitionUniqueBatchEntries,
  resolveEffectiveOutOfStockOnline,
  type BranchRef,
  type ExistingOfferLocationRow,
  type ShopPriceRow,
} from "./scrape-write-plan.js";
import type { ScrapeLocationAvailability, ScrapePriceResult, ScrapePriceSuccess } from "../types.js";

function baseRow(overrides: Partial<ShopPriceRow> = {}): ShopPriceRow {
  return {
    productId: 100,
    shopId: 14,
    url: "https://supermix.com.do/p/arroz-10-lb",
    api: "12345",
    locationId: null,
    currentPrice: "350.00",
    regularPrice: null,
    purchaseMode: null,
    purchaseUnit: null,
    minimumPurchaseQuantity: null,
    purchaseQuantityIncrement: null,
    maximumPurchaseQuantity: null,
    priceReferenceQuantity: null,
    purchaseTermsSource: null,
    updateAt: new Date("2026-11-28T06:00:00Z"),
    hidden: false,
    outOfStockOnline: false,
    ...overrides,
  };
}

function baseSuccess(overrides: Partial<ScrapePriceSuccess> = {}): ScrapePriceSuccess {
  return {
    status: "ok",
    shopId: 14,
    shopName: "supermix",
    currentPrice: "350",
    regularPrice: null,
    locationId: null,
    outOfStockOnline: false,
    ...overrides,
  };
}

test("classifyScrapeWrite: unchanged visible row with matching outOfStockOnline uses batch_touch", () => {
  const plan = classifyScrapeWrite(baseRow(), baseSuccess());
  assert.deepEqual(plan, {
    kind: "batch_touch",
    hasPurchaseTerms: false,
    expectedOutOfStockOnline: false,
  });
});

test("classifyScrapeWrite: unchanged row with matching purchaseTerms keeps hasPurchaseTerms=true", () => {
  const row = baseRow({
    shopId: 1,
    purchaseMode: "unit",
    purchaseUnit: "unit",
    minimumPurchaseQuantity: "1",
    purchaseQuantityIncrement: "1",
    maximumPurchaseQuantity: null,
    priceReferenceQuantity: "1",
    purchaseTermsSource: "sirena_vtex",
  });
  const result = baseSuccess({
    shopId: 1,
    shopName: "sirena",
    purchaseTerms: {
      mode: "unit",
      unit: "unit",
      minimum: "1",
      increment: "1",
      maximum: null,
      priceReferenceQuantity: "1",
      source: "sirena_vtex",
      evidence: { measurementUnit: "un" },
    },
  });

  assert.deepEqual(classifyScrapeWrite(row, result), {
    kind: "batch_touch",
    hasPurchaseTerms: true,
    expectedOutOfStockOnline: false,
  });
});

test("classifyScrapeWrite: falls back to individual when outOfStockOnline changed or was not loaded", () => {
  assert.deepEqual(
    classifyScrapeWrite(baseRow({ outOfStockOnline: false }), baseSuccess({ outOfStockOnline: true })),
    { kind: "individual" }
  );
  assert.deepEqual(
    classifyScrapeWrite(baseRow({ outOfStockOnline: null }), baseSuccess({ outOfStockOnline: false })),
    { kind: "individual" }
  );
  assert.deepEqual(
    classifyScrapeWrite(baseRow({ outOfStockOnline: undefined }), baseSuccess({ outOfStockOnline: false })),
    { kind: "individual" }
  );
  // Omitted outOfStockOnline signal still qualifies for batch_touch even if row didn't load it.
  const withoutSignal = baseSuccess();
  delete withoutSignal.outOfStockOnline;
  assert.deepEqual(
    classifyScrapeWrite(baseRow({ outOfStockOnline: undefined }), withoutSignal),
    {
      kind: "batch_touch",
      hasPurchaseTerms: false,
      expectedOutOfStockOnline: undefined,
    }
  );
});

test("classifyScrapeWrite: falls back to individual for hidden, price, URL, terms, measurement, or error rows", () => {
  assert.deepEqual(classifyScrapeWrite(baseRow({ hidden: true }), baseSuccess()), {
    kind: "individual",
  });
  assert.deepEqual(
    classifyScrapeWrite(baseRow(), baseSuccess({ currentPrice: "340" })),
    { kind: "individual" }
  );
  assert.deepEqual(
    classifyScrapeWrite(
      baseRow(),
      baseSuccess({ canonicalUrl: "https://supermix.com.do/p/arroz-10-lb-nuevo" })
    ),
    { kind: "individual" }
  );
  assert.deepEqual(
    classifyScrapeWrite(
      baseRow(),
      baseSuccess({
        purchaseTerms: {
          mode: "measure",
          unit: "lb",
          minimum: "0.5",
          increment: "0.5",
          maximum: null,
          priceReferenceQuantity: "1",
          source: "supermix_vendabo_product",
          evidence: {},
        },
      })
    ),
    { kind: "individual" }
  );
  assert.deepEqual(
    classifyScrapeWrite(
      baseRow(),
      baseSuccess({
        productMeasurementUpdate: {
          declaredQuantity: "1",
          declaredUnit: "lb",
          canonicalQuantity: "453.592",
        },
      })
    ),
    { kind: "individual" }
  );
  const notFoundResult: ScrapePriceResult = {
    status: "not_found",
    shopId: 14,
    shopName: "supermix",
    reason: "product_not_found",
    hide: true,
  };
  assert.deepEqual(classifyScrapeWrite(baseRow(), notFoundResult), {
    kind: "individual",
  });
});

test("classifyScrapeWrite: routes branch rows to batch_locations and detects post-stock batch touch eligibility", () => {
  const branches: ScrapeLocationAvailability[] = [
    { externalId: "902", available: true, stock: 12, currentPrice: null, regularPrice: null },
  ];

  assert.deepEqual(
    classifyScrapeWrite(
      baseRow({ shopId: 7 }),
      baseSuccess({ shopId: 7, shopName: "merca_jumbo", locations: branches })
    ),
    {
      kind: "batch_locations",
      canBatchTouchAfterStock: true,
      hasPurchaseTerms: false,
    }
  );

  // Price change on a branch row still shares the batch stock transaction,
  // then runs individual price update afterwards.
  assert.deepEqual(
    classifyScrapeWrite(
      baseRow({ shopId: 7 }),
      baseSuccess({
        shopId: 7,
        shopName: "merca_jumbo",
        currentPrice: "399",
        locations: branches,
      })
    ),
    {
      kind: "batch_locations",
      canBatchTouchAfterStock: false,
      hasPurchaseTerms: false,
    }
  );
});

test("resolveEffectiveOutOfStockOnline: active branches decide online availability", () => {
  const ids = new Map<string, BranchRef>([
    ["902", { id: 1, active: false }],
    ["904", { id: 2, active: true }],
  ]);

  const onlyClosedHasStock = new Map<string, ScrapeLocationAvailability>([
    ["902", { externalId: "902", available: true, stock: 10, currentPrice: null, regularPrice: null }],
    ["904", { externalId: "904", available: true, stock: 0, currentPrice: null, regularPrice: null }],
  ]);
  assert.equal(resolveEffectiveOutOfStockOnline(onlyClosedHasStock, ids, false), true);

  const activeHasStock = new Map<string, ScrapeLocationAvailability>([
    ["902", { externalId: "902", available: false, stock: 0, currentPrice: null, regularPrice: null }],
    ["904", { externalId: "904", available: true, stock: 3, currentPrice: null, regularPrice: null }],
  ]);
  assert.equal(resolveEffectiveOutOfStockOnline(activeHasStock, ids, true), false);

  // Empty branch list falls back to store's outOfStockOnline flag.
  assert.equal(resolveEffectiveOutOfStockOnline(new Map(), ids, false), false);
  assert.equal(resolveEffectiveOutOfStockOnline(new Map(), ids, true), true);
});

test("diffOfferLocations: detects unchanged, updated, added, and removed branch rows accurately", () => {
  const now = new Date("2026-11-28T12:00:00Z");
  const ids = new Map<string, BranchRef>([
    ["902", { id: 10, active: true }],
    ["904", { id: 11, active: true }],
  ]);
  const byCode = new Map<string, ScrapeLocationAvailability>([
    ["902", { externalId: "902", available: true, stock: 5, currentPrice: "100.00", regularPrice: null }],
    ["904", { externalId: "904", available: false, stock: 0, currentPrice: null, regularPrice: null }],
  ]);
  const values = buildOfferLocationValues({ productId: 1, shopId: 7 }, byCode, ids, now);

  const identicalExisting: ExistingOfferLocationRow[] = [
    { locationId: 10, available: true, stock: "5.0", currentPrice: "100", regularPrice: null },
    { locationId: 11, available: false, stock: "0", currentPrice: null, regularPrice: null },
  ];
  assert.deepEqual(diffOfferLocations(identicalExisting, values), {
    changed: false,
    staleLocationIds: [],
  });

  const withStaleBranch: ExistingOfferLocationRow[] = [
    ...identicalExisting,
    { locationId: 12, available: true, stock: "2", currentPrice: null, regularPrice: null },
  ];
  assert.deepEqual(diffOfferLocations(withStaleBranch, values), {
    changed: true,
    staleLocationIds: [12],
  });

  const stockChanged: ExistingOfferLocationRow[] = [
    { locationId: 10, available: true, stock: "4", currentPrice: "100", regularPrice: null },
    { locationId: 11, available: false, stock: "0", currentPrice: null, regularPrice: null },
  ];
  assert.deepEqual(diffOfferLocations(stockChanged, values), {
    changed: true,
    staleLocationIds: [],
  });

  // Clearing all branches deletes all existing rows; already-empty is a no-op.
  assert.deepEqual(diffOfferLocations(identicalExisting, []), {
    changed: true,
    staleLocationIds: [10, 11],
  });
  assert.deepEqual(diffOfferLocations([], []), {
    changed: false,
    staleLocationIds: [],
  });
});

test("partitionUniqueBatchEntries: separates duplicate (shopId, productId) keys", () => {
  const a = [baseRow({ productId: 1, shopId: 7 }), baseSuccess({ shopId: 7 })] as const;
  const b = [baseRow({ productId: 2, shopId: 7 }), baseSuccess({ shopId: 7 })] as const;
  const dup = [baseRow({ productId: 1, shopId: 7 }), baseSuccess({ shopId: 7, currentPrice: "360" })] as const;

  const { unique, duplicates } = partitionUniqueBatchEntries([a, b, dup]);
  assert.deepEqual(unique, [b]);
  assert.deepEqual(duplicates, [a, dup]);
});
