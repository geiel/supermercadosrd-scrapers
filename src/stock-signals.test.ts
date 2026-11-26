import assert from "node:assert/strict";
import test from "node:test";

for (const name of [
  "SIRENA_PRODUCT_API_URL_TEMPLATE",
  "SIRENA_CATEGORY_TREE_API_URL_TEMPLATE",
  "SIRENA_PRODUCTS_SEARCH_API_URL",
  "NACIONAL_REST_API_URL",
  "PLAZA_LAMA_GRAPHQL_URL",
  "PLAZA_LAMA_DPL_API_KEY",
  "PRICESMART_PRODUCT_API_URL",
  "PRICESMART_DISCOVERY_API_URL",
]) {
  process.env[name] ??= "https://example.com";
}

const { bravoPriceFromPayload, bravoLocationInStock } = await import("./shops/bravo.js");
const { pricesmartClubLocations } = await import("./shops/pricesmart.js");
const { toSirenaVtexPriceResult } = await import("./shops/sirena.js");
const { toNacionalGraphqlPriceResult } = await import("./shops/nacional.js");
const { magentoOutOfStockOnline } = await import("./shops/magento-graphql-batch.js");

const input = { shopId: 6 as const, url: "https://bravova.com/p/1", api: null };

function bravoPayload(
  tiendas: Array<{ id: number; disponible?: boolean; stock?: number; pvp?: number; oferta?: number }>
) {
  return {
    data: {
      idArticulo: 1025,
      associatedTienda: tiendas.map((tienda) => ({
        idTiendaArticuloTienda: tienda.id,
        pvpArticuloTienda: tienda.pvp ?? 78,
        ...(tienda.disponible === undefined ? {} : { disponibleArticuloTienda: tienda.disponible }),
        ...(tienda.stock === undefined ? {} : { stockArticuloTienda: tienda.stock }),
        associatedOferta:
          tienda.oferta === undefined ? [] : [{ precioReferenciaArticuloTiendaOferta: tienda.oferta }],
      })),
    },
  };
}

test("Bravo: every branch is kept, and out of stock in one is not out of stock online", () => {
  const result = bravoPriceFromPayload(
    bravoPayload([
      { id: 1000, disponible: false, stock: 0 },
      { id: 1010, disponible: true, stock: 64 },
      { id: 1008, disponible: true, stock: 107, pvp: 199, oferta: 249 },
    ]),
    input
  );

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.currentPrice, "78");
  assert.equal(result.locationId, "1000");
  assert.equal(result.outOfStockOnline, false);
  assert.deepEqual(result.locations, [
    { externalId: "1000", available: false, stock: 0, currentPrice: "78", regularPrice: null },
    { externalId: "1010", available: true, stock: 64, currentPrice: "78", regularPrice: null },
    { externalId: "1008", available: true, stock: 107, currentPrice: "199", regularPrice: "249" },
  ]);
});

test("Bravo: out of stock online only when no branch has it", () => {
  const result = bravoPriceFromPayload(
    bravoPayload([
      { id: 1000, disponible: false, stock: 3 },
      { id: 1010, disponible: true, stock: 0 },
    ]),
    input
  );

  assert.equal(result.status === "ok" && result.outOfStockOnline, true);
  assert.equal(
    bravoLocationInStock({ externalId: "1", available: true, stock: null, currentPrice: null, regularPrice: null }),
    true
  );
});

test("Bravo: no availability fields means no signal", () => {
  const result = bravoPriceFromPayload(bravoPayload([{ id: 1000 }]), input);

  assert.equal(result.status === "ok" && result.outOfStockOnline, null);
  assert.deepEqual(result.status === "ok" && result.locations, []);
});

test("PriceSmart: one row per Dominican club with a known availability", () => {
  const candidate = (club: string | undefined, available: boolean | null, country = "DO") => ({
    country,
    club,
    currentPrice: "1250",
    regularPrice: "1400",
    available,
    soldByWeight: null,
    sourceUnit: null,
    parsedSourceUnit: null,
  });

  const clubs = pricesmartClubLocations([
    candidate("6801", false),
    candidate("6804", true),
    candidate("68", true),
    candidate("6805", null),
    candidate("7001", true, "CR"),
    candidate("6801", true),
  ]);

  assert.deepEqual(clubs, [
    { externalId: "6801", available: false, stock: null, currentPrice: "1250", regularPrice: "1400" },
    { externalId: "6804", available: true, stock: null, currentPrice: "1250", regularPrice: "1400" },
  ]);
});

test("Sirena VTEX: IsAvailable false keeps the price, out of stock online", () => {
  const product = (isAvailable: boolean | undefined) => ({
    productId: "18772",
    productName: "Producto",
    linkText: "producto-2098694",
    link: "https://www.sirena.do/producto-2098694/p",
    productReference: "2098694",
    categories: [],
    items: [
      {
        itemId: "13055",
        measurementUnit: "un",
        unitMultiplier: 1,
        images: [],
        sellers: [
          {
            sellerDefault: true,
            commertialOffer: {
              Price: 120,
              ListPrice: 120,
              ...(isAvailable === undefined ? {} : { IsAvailable: isAvailable }),
            },
          },
        ],
      },
    ],
  });

  const out = toSirenaVtexPriceResult(product(false) as never, {});
  assert.equal(out.status === "ok" && out.currentPrice, "120.00");
  assert.equal(out.status === "ok" && out.outOfStockOnline, true);

  const inStock = toSirenaVtexPriceResult(product(true) as never, {});
  assert.equal(inStock.status === "ok" && inStock.outOfStockOnline, false);

  const unknown = toSirenaVtexPriceResult(product(undefined) as never, {});
  assert.equal(unknown.status === "ok" && unknown.outOfStockOnline, null);
});

test("Magento stores read stock_status, and anything else is no signal", () => {
  assert.equal(magentoOutOfStockOnline("OUT_OF_STOCK"), true);
  assert.equal(magentoOutOfStockOnline("IN_STOCK"), false);
  assert.equal(magentoOutOfStockOnline(null), null);
  assert.equal(magentoOutOfStockOnline("SOMETHING_NEW"), null);

  const result = toNacionalGraphqlPriceResult({
    sku: "2010123",
    stock_status: "OUT_OF_STOCK",
    price_range: { minimum_price: { final_price: { value: 99 }, regular_price: { value: 99 } } },
  });
  assert.equal(result.status === "ok" && result.currentPrice, "99");
  assert.equal(result.status === "ok" && result.outOfStockOnline, true);
});
