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

test("Bravo: a branch without availability makes the whole answer unknown", () => {
  const partial = bravoPriceFromPayload(
    bravoPayload([{ id: 1000, disponible: false, stock: 0 }, { id: 1010 }]),
    input
  );
  assert.equal(partial.status === "ok" && "outOfStockOnline" in partial, false);
  assert.equal(partial.status === "ok" && "locations" in partial, false);
});

test("Bravo: no availability fields means nothing is known", () => {
  const result = bravoPriceFromPayload(bravoPayload([{ id: 1000 }]), input);

  assert.equal(result.status === "ok" && "outOfStockOnline" in result, false);
  assert.equal(result.status === "ok" && "locations" in result, false);
});

test("PriceSmart: one row per Dominican club with a known availability, priced or not", () => {
  const candidate = (club: string) => ({
    country: "DO",
    club,
    currentPrice: "1250",
    regularPrice: "1400",
    available: true,
    soldByWeight: null,
    sourceUnit: null,
    parsedSourceUnit: null,
  });
  const availability = (club: string | undefined, value: unknown, country = "DO") => ({ country, club, value });

  const clubs = pricesmartClubLocations(
    [
      availability("6801", "false"),
      availability("6804", "true"),
      availability("68", "true"),
      availability("6805", null),
      availability("7001", "true", "CR"),
      availability("6801", "true"),
    ],
    // Only Los Prados has a price: Arroyo Hondo's availability still counts.
    [candidate("6801")]
  );

  assert.deepEqual(clubs, [
    { externalId: "6801", available: false, stock: null, currentPrice: "1250", regularPrice: "1400" },
    { externalId: "6804", available: true, stock: null, currentPrice: null, regularPrice: null },
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
  assert.equal(unknown.status === "ok" && "outOfStockOnline" in unknown, false);
});

test("Magento stores read stock_status, and anything else is no signal", () => {
  assert.equal(magentoOutOfStockOnline("OUT_OF_STOCK"), true);
  assert.equal(magentoOutOfStockOnline("IN_STOCK"), false);
  assert.equal(magentoOutOfStockOnline(null), undefined);
  assert.equal(magentoOutOfStockOnline("SOMETHING_NEW"), undefined);

  const result = toNacionalGraphqlPriceResult({
    sku: "2010123",
    stock_status: "OUT_OF_STOCK",
    price_range: { minimum_price: { final_price: { value: 99 }, regular_price: { value: 99 } } },
  });
  assert.equal(result.status === "ok" && result.currentPrice, "99");
  assert.equal(result.status === "ok" && result.outOfStockOnline, true);
});

const { toCcnLeftOutResult } = await import("./shops/ccn-rest-stock.js");

test("CCN: a product GraphQL left out is out of stock online while its website still sells it", () => {
  const item = (status: number, websites: number[], extra: Array<{ attribute_code: string; value: unknown }> = []) => ({
    sku: "2165645",
    status,
    price: 499.95,
    extension_attributes: { website_ids: websites },
    custom_attributes: extra,
  });

  const out = toCcnLeftOutResult(2, item(1, [1, 51]));
  assert.equal(out.status === "ok" && out.currentPrice, "499.95");
  assert.equal(out.status === "ok" && out.outOfStockOnline, true);

  const onSale = toCcnLeftOutResult(
    2,
    item(1, [1], [
      { attribute_code: "special_price", value: "449.950000" },
      { attribute_code: "special_from_date", value: "2026-11-13 00:00:00" },
      { attribute_code: "special_to_date", value: "2026-11-27 00:00:00" },
    ]),
    new Date("2026-11-26T12:00:00Z")
  );
  assert.equal(onSale.status === "ok" && onSale.currentPrice, "449.95");
  assert.equal(onSale.status === "ok" && onSale.regularPrice, "499.95");

  // Disabled, or no longer on that store's website: gone, hidden.
  const disabled = toCcnLeftOutResult(3, item(2, [51]));
  assert.equal(disabled.status === "not_found" && disabled.hide, true);
  const otherWebsite = toCcnLeftOutResult(7, item(1, [1]));
  assert.equal(otherWebsite.status === "not_found" && otherWebsite.hide, true);
  assert.equal(toCcnLeftOutResult(7, item(1, [1, 51, 59])).status, "ok");
});

const { toMercaJumboPriceResult } = await import("./shops/merca-jumbo.js");

test("Merca Jumbo: branches decide out of stock online when they are known", () => {
  const product = (locations?: Array<{ externalId: string; available: boolean; stock: number | null }>) => ({
    outOfStockOnline: false,
    sku: "2006566",
    name: "Tomates",
    urlKey: null,
    imageUrls: [],
    finalPrice: "95",
    regularPrice: "95",
    purchaseTermsFields: { sku: "2006566" },
    ...(locations
      ? { locations: locations.map((location) => ({ ...location, currentPrice: null, regularPrice: null })) }
      : {}),
  });

  const some = toMercaJumboPriceResult(product([
    { externalId: "902", available: true, stock: 12 },
    { externalId: "904", available: true, stock: 0 },
  ]) as never, {});
  assert.equal(some.status === "ok" && some.outOfStockOnline, false);
  assert.equal(some.status === "ok" && some.locations?.length, 2);

  const none = toMercaJumboPriceResult(product([
    { externalId: "902", available: false, stock: 5 },
    { externalId: "904", available: true, stock: 0 },
  ]) as never, {});
  assert.equal(none.status === "ok" && none.outOfStockOnline, true);

  // Branches unread: the stored flag and branch rows stay together.
  const unread = toMercaJumboPriceResult(product() as never, {});
  assert.equal(unread.status === "ok" && "outOfStockOnline" in unread, false);
  assert.equal(unread.status === "ok" && "locations" in unread, false);

  // In no branch at all: stock_status decides, and the old branch rows go with it.
  const nowhere = toMercaJumboPriceResult(product([]) as never, {});
  assert.equal(nowhere.status === "ok" && nowhere.outOfStockOnline, false);
  assert.deepEqual(nowhere.status === "ok" && nowhere.locations, []);

  // In no branch and no known stock_status: nothing changes.
  const unknown = toMercaJumboPriceResult({ ...product([]), outOfStockOnline: undefined } as never, {});
  assert.equal(unknown.status === "ok" && "outOfStockOnline" in unknown, false);
  assert.equal(unknown.status === "ok" && "locations" in unknown, false);
});

test("CCN: what REST leaves unsaid never hides an offer", () => {
  const unknownSite = toCcnLeftOutResult(3, { sku: "1", status: 1, price: 10 });
  assert.equal(unknownSite.status === "error" && unknownSite.hide, false);
  const noStatus = toCcnLeftOutResult(3, { sku: "1", price: 10, extension_attributes: { website_ids: [51] } });
  assert.equal(noStatus.status === "error" && noStatus.hide, false);
  const noPrice = toCcnLeftOutResult(3, { sku: "1", status: 1, extension_attributes: { website_ids: [51] } });
  assert.equal(noPrice.status === "error" && noPrice.hide, false);
  // Merca's left-out product: no branch has it.
  const merca = toCcnLeftOutResult(7, { sku: "1", status: 1, price: 10, extension_attributes: { website_ids: [59] } });
  assert.deepEqual(merca.status === "ok" && merca.locations, []);
});
