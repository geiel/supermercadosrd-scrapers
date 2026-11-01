import assert from "node:assert/strict";
import test from "node:test";

for (const name of [
  "SIRENA_PRODUCT_API_URL_TEMPLATE", "SIRENA_PRODUCTS_SEARCH_API_URL",
  "SIRENA_CATEGORY_TREE_API_URL_TEMPLATE", "NACIONAL_REST_API_URL",
  "PLAZA_LAMA_GRAPHQL_URL", "PLAZA_LAMA_DPL_API_KEY",
]) process.env[name] ??= "https://example.com";
process.env.PRICESMART_PRODUCT_API_URL = "https://example.com/product";
process.env.PRICESMART_DISCOVERY_API_URL = "https://example.com/discovery";

const { extractPricesmartProductImages, scrapePricesmartImages } = await import(
  "./shops/pricesmart-images.js"
);

function payload(variants: unknown[], masterVariant?: unknown) {
  return { data: { products: { results: [{ masterData: { current: {
    allVariants: variants, masterVariant,
  } } }] } } };
}

function variant(sku: string, value: unknown) {
  return { sku, images: [], attributesRaw: [{ name: "localized_images", value }] };
}

test("extracts the projector's seven photos once, preferring Dominican Spanish", () => {
  const photos = Array.from({ length: 7 }, (_, i) => ({
    "es-DO": `https://images.example.com/${i + 1}.jpg`,
    "es-CR": `https://images.example.com/cr-${i + 1}.jpg`,
    "en-DO": `https://images.example.com/en-${i + 1}.jpg`,
  }));
  const projector = variant("506853", photos);
  assert.deepEqual(
    extractPricesmartProductImages(payload([projector], projector), "506853"),
    photos.map((photo) => photo["es-DO"])
  );
});

test("keeps the linked color's gallery separate from other SKUs", () => {
  const grey = variant("502923-0198062087739", [
    { "es-CR": "https://images.example.com/grey-1.jpg" },
    { "es-CR": "https://images.example.com/grey-2.jpg" },
  ]);
  const white = variant("502923-0198062087760", [
    { "es-CR": "https://images.example.com/white.jpg" },
  ]);
  assert.deepEqual(
    extractPricesmartProductImages(payload([white, grey], white), grey.sku),
    ["https://images.example.com/grey-1.jpg", "https://images.example.com/grey-2.jpg"]
  );
  assert.deepEqual(extractPricesmartProductImages(payload([white]), grey.sku), []);
});

test("accepts serialized localized images and standard image URLs", () => {
  const item = {
    ...variant("123", JSON.stringify([
      { "en-CR": "https://images.example.com/one.jpg" },
      { "es-DO": "javascript:bad" },
      null,
    ])),
    images: [
      { url: "https://images.example.com/one.jpg" },
      { url: "https://images.example.com/two.jpg" },
    ],
  };
  assert.deepEqual(extractPricesmartProductImages(payload([item]), "123"), [
    "https://images.example.com/one.jpg", "https://images.example.com/two.jpg",
  ]);
  assert.deepEqual(extractPricesmartProductImages({ data: null }, "123"), []);
});

test("reads a variant SKU from the URL and uses the product API gallery", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body[0].skus, ["502923-0198062087739"]);
    return Response.json(payload([variant("502923-0198062087739", [
      { "es-CR": "https://images.example.com/grey-1.jpg" },
      { "es-CR": "https://images.example.com/grey-2.jpg" },
    ])]));
  });
  const result = await scrapePricesmartImages({
    shopId: 5,
    url: "https://www.pricesmart.com/es-do/producto/blanket/502923-0198062087739?source=test",
  }, { maxRetries: 0 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" && result.images, [
    "https://images.example.com/grey-1.jpg", "https://images.example.com/grey-2.jpg",
  ]);
  assert.deepEqual(calls, [process.env.PRICESMART_PRODUCT_API_URL]);
});

test("falls back only to an exact product thumbnail, never the first search hit", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).endsWith("/product")) return Response.json(payload([]));
    return Response.json({ response: { docs: [
      { master_sku: "999", thumb_image: "https://images.example.com/wrong.jpg" },
      { master_sku: "123", thumb_image: "https://images.example.com/right.jpg" },
    ] } });
  });
  const result = await scrapePricesmartImages({ shopId: 5, url: "/product/123" });
  assert.deepEqual(result.status === "ok" && result.images, ["https://images.example.com/right.jpg"]);
  const missing = await scrapePricesmartImages({ shopId: 5, url: "/product/456" });
  assert.equal(missing.status, "not_found");
});

test("does not use the master thumbnail for a variant listed by discovery", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).endsWith("/product")) return Response.json(payload([]));
    return Response.json({ response: { docs: [{
      master_sku: "123", thumb_image: "https://images.example.com/master.jpg",
      variants: [{ skuid: "123-456" }],
    }] } });
  });
  const result = await scrapePricesmartImages({ shopId: 5, url: "/product/123-456" });
  assert.equal(result.status, "not_found");
});
