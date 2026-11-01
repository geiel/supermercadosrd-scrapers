import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

for (const name of [
  "SIRENA_PRODUCT_API_URL_TEMPLATE",
  "SIRENA_CATEGORY_TREE_API_URL_TEMPLATE",
  "NACIONAL_REST_API_URL",
  "PLAZA_LAMA_GRAPHQL_URL",
  "PLAZA_LAMA_DPL_API_KEY",
  "PRICESMART_PRODUCT_API_URL",
  "PRICESMART_DISCOVERY_API_URL",
]) {
  process.env[name] ??= "https://example.com";
}

const sirenaRequests: URL[] = [];
const sirenaServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  sirenaRequests.push(url);
  response.writeHead(200, {
    "content-type": "application/json",
    resources: "0-49/3",
  });
  response.end(
    JSON.stringify([
      sirenaProduct({ productId: "18772", reference: "2098694", slug: "maybelline-lip-lifter-liner-09-peaking-2098694", price: 588.75, listPrice: 785 }),
      { productId: "1", note: "malformed: no productName" },
      sirenaProduct({ productId: "20960", reference: "1144425001", slug: "tropical-ultratex-gl-blanco-00-1144425001", price: 740, listPrice: 740 }),
    ])
  );
});
await new Promise<void>((resolve) => sirenaServer.listen(0, "127.0.0.1", resolve));
process.env.SIRENA_PRODUCTS_SEARCH_API_URL = `http://127.0.0.1:${(sirenaServer.address() as AddressInfo).port}/api/catalog_system/pub/products/search`;
test.after(() => sirenaServer.close());

const {
  batchLookupKeys,
  chunkBatchRows,
  matchSirenaProducts,
  matchSkuItems,
  parseSirenaBatchReference,
  SIRENA_BATCH_API_PATTERN,
} = await import("./batch-price-sync.js");
const { fetchSirenaVtexProductsByFilter, parseSirenaVtexProductsPayload } = await import("./sirena-vtex.js");
const { fetchMagentoGraphqlItemsBySku } = await import("./shops/magento-graphql-batch.js");
const { toNacionalGraphqlPriceResult } = await import("./shops/nacional.js");
const { toSirenaVtexPriceResult } = await import("./shops/sirena.js");
const { z } = await import("zod");

type Row = Parameters<typeof batchLookupKeys>[0];

function row(shopId: number, url: string, api: string | null = null, productId = 1): Row {
  return {
    productId,
    shopId,
    url,
    api,
    locationId: null,
    currentPrice: "100",
    regularPrice: null,
    purchaseMode: null,
    purchaseUnit: null,
    minimumPurchaseQuantity: null,
    purchaseQuantityIncrement: null,
    maximumPurchaseQuantity: null,
    priceReferenceQuantity: null,
    purchaseTermsSource: null,
    updateAt: null,
    hidden: false,
  };
}

function sirenaProduct(input: {
  productId: string;
  reference: string;
  slug: string;
  price: number;
  listPrice: number;
}) {
  return {
    productId: input.productId,
    productName: "Producto",
    linkText: input.slug,
    link: `https://www.sirena.do/${input.slug}/p`,
    productReference: input.reference,
    productReferenceCode: input.reference,
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
            commertialOffer: { Price: input.price, ListPrice: input.listPrice },
          },
        ],
      },
    ],
  };
}

const sirenaSlugApi =
  "https://www.sirena.do/api/catalog_system/pub/products/search/maybelline-lip-lifter-liner-09-peaking-2098694/p";
const sirenaIdApi =
  "https://www.sirena.do/api/catalog_system/pub/products/search?fq=productId:20960";

test("batches Sirena rows by VTEX reference or product id, not the old API", () => {
  assert.deepEqual(parseSirenaBatchReference({ api: sirenaSlugApi, url: "" }), {
    field: "alternateIds_RefId",
    value: "2098694",
    slug: "maybelline-lip-lifter-liner-09-peaking-2098694",
  });
  assert.deepEqual(parseSirenaBatchReference({ api: sirenaIdApi, url: "" }), {
    field: "productId",
    value: "20960",
  });

  for (const api of [
    "https://st.sirena.do/product/detail/YWxjb2hvbA==/YzgzNDRhYWRj",
    "https://www.sirena.do/api/catalog_system/pub/products/search/?fq=alternateIds_Ean:7501031311309",
    "https://www.sirena.do/api/catalog_system/pub/products/search/slug-without-reference/p",
    `${sirenaIdApi}&sc=1`,
    "",
  ]) {
    assert.equal(parseSirenaBatchReference({ api, url: "" }), null, api);
  }

  // A missing api falls back to the url, as the single lookup does.
  assert.equal(
    parseSirenaBatchReference({ api: null, url: sirenaSlugApi })?.value,
    "2098694"
  );
  // The pattern is shared with Postgres, which has no lookbehind or \d.
  assert.doesNotMatch(SIRENA_BATCH_API_PATTERN, /\(\?<|\\d/);
});

test("builds lookup keys per shop and leaves unbatchable rows to the single lookup", () => {
  assert.deepEqual(
    batchLookupKeys(row(2, "https://supermercadosnacional.com/gatorade-sabor-fruit-punch-600-ml-2010123")),
    { group: "nacional", keys: ["2010123"] }
  );
  assert.deepEqual(
    batchLookupKeys(row(3, "https://jumbo.com.do/bicarbonato-de-sodio-lider-100-gr-9982168236")),
    { group: "jumbo", keys: ["9982168236", "2168236"] }
  );
  assert.deepEqual(
    batchLookupKeys(row(7, "https://supermercadosnacional.com/tocineta-ahumada-lider-8-onz-2217470", "https://supermercadosnacional.com/graphql")),
    { group: "merca_jumbo:https://supermercadosnacional.com/graphql", keys: ["2217470"] }
  );
  assert.equal(batchLookupKeys(row(2, "https://supermercadosnacional.com/sin-sku")), null);
  assert.equal(batchLookupKeys(row(4, "https://plazalama.com.do/p/x-123456")), null);
});

test("packs rows into requests of at most maxKeys keys without mixing groups", () => {
  const rows = [
    row(1, sirenaSlugApi, sirenaSlugApi, 1),
    row(1, sirenaIdApi, sirenaIdApi, 2),
    row(1, sirenaSlugApi, sirenaSlugApi, 3),
    row(1, sirenaSlugApi.replace("2098694", "1027594"), null, 4),
    row(1, sirenaSlugApi.replace("2098694", "1061566"), null, 5),
  ];
  const chunks = chunkBatchRows(
    rows.map((item) => ({ row: item, lookup: batchLookupKeys(item)! })),
    2
  );

  assert.deepEqual(
    chunks.map((chunk) => ({
      group: chunk.group,
      keys: chunk.keys,
      rows: chunk.rows.map((item) => item.productId),
    })),
    [
      // Rows 1 and 3 share one reference and so one key.
      { group: "alternateIds_RefId", keys: ["2098694", "1027594"], rows: [1, 3, 4] },
      { group: "productId", keys: ["20960"], rows: [2] },
      { group: "alternateIds_RefId", keys: ["1061566"], rows: [5] },
    ]
  );
});

test("matches a Sirena reference only when the slug matches too", () => {
  const bySlug = row(1, sirenaSlugApi, sirenaSlugApi, 1);
  const byId = row(1, sirenaIdApi, sirenaIdApi, 2);
  const renamed = row(1, "", sirenaSlugApi.replace("maybelline-lip-lifter", "maybelline-old-name"), 3);
  const product = sirenaProduct({ productId: "18772", reference: "2098694", slug: "maybelline-lip-lifter-liner-09-peaking-2098694", price: 588.75, listPrice: 785 });
  const other = sirenaProduct({ productId: "20960", reference: "1144425001", slug: "tropical-ultratex-gl-blanco-00-1144425001", price: 740, listPrice: 740 });

  const matches = matchSirenaProducts([bySlug, byId, renamed], [product, other]);
  assert.equal(matches.get(bySlug)?.productId, "18772");
  assert.equal(matches.get(byId)?.productId, "20960");
  assert.equal(matches.has(renamed), false);

  // Two products under one reference: neither is trusted.
  const duplicate = { ...product, productId: "99999" };
  assert.equal(matchSirenaProducts([bySlug], [product, duplicate]).size, 0);
});

test("prices a batched Sirena product exactly like the single lookup", () => {
  // Batched products go through the same schema as single-lookup ones.
  const [product, soldOut] = parseSirenaVtexProductsPayload([
    sirenaProduct({ productId: "18772", reference: "2098694", slug: "x-2098694", price: 588.75, listPrice: 785 }),
    sirenaProduct({ productId: "1", reference: "1", slug: "x-1", price: 0, listPrice: 0 }),
  ])!;
  const result = toSirenaVtexPriceResult(product, {});
  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" && result.currentPrice, "588.75");
  assert.equal(result.status === "ok" && result.regularPrice, "785.00");

  assert.deepEqual(toSirenaVtexPriceResult(soldOut, {}), {
    status: "not_found",
    shopId: 1,
    shopName: "sirena",
    reason: "vtex_price_not_found",
    hide: true,
  });
});

test("fetches up to 50 Sirena products with repeated fq filters", async () => {
  const lookup = await fetchSirenaVtexProductsByFilter("alternateIds_RefId", ["2098694", "1144425001"]);
  assert.equal(lookup.ok, true);
  assert.equal(lookup.ok && lookup.total, 3);
  // The malformed product is dropped, not the whole response.
  assert.deepEqual(lookup.ok && lookup.products.map((product) => product.productId), ["18772", "20960"]);

  const request = sirenaRequests.at(-1)!;
  assert.deepEqual(request.searchParams.getAll("fq"), [
    "alternateIds_RefId:2098694",
    "alternateIds_RefId:1144425001",
  ]);
  assert.equal(request.searchParams.get("_from"), "0");
  assert.equal(request.searchParams.get("_to"), "49");
});

test("picks the first listed SKU candidate and skips malformed items", () => {
  const jumbo = row(3, "https://jumbo.com.do/bicarbonato-de-sodio-lider-100-gr-9982168236", null, 1);
  const malformed = row(2, "https://supermercadosnacional.com/x-2010123", null, 2);
  const absent = row(2, "https://supermercadosnacional.com/x-2010999", null, 3);
  const items = new Map<string, { sku: string } | null>([
    ["2168236", { sku: "2168236" }],
    ["2010123", null],
  ]);

  const matches = matchSkuItems([jumbo, malformed, absent], items);
  assert.equal(matches.get(jumbo)?.sku, "2168236");
  assert.equal(matches.has(malformed), false);
  assert.equal(matches.has(absent), false);
});

test("prices Nacional GraphQL items with the REST special-price rule", () => {
  const now = new Date("2026-10-31T12:00:00");
  const item = (special: number | null, from: string | null, to: string | null) => ({
    sku: "2010123",
    special_price: special,
    special_from_date: from,
    special_to_date: to,
    price_range: { minimum_price: { regular_price: { value: 120 } } },
  });

  const active = toNacionalGraphqlPriceResult(item(99.5, "2026-10-01 00:00:00", "2026-11-30 23:59:59"), now);
  assert.equal(active.status === "ok" && active.currentPrice, "99.5");
  assert.equal(active.status === "ok" && active.regularPrice, "120");

  const expired = toNacionalGraphqlPriceResult(item(99.5, "2026-09-01 00:00:00", "2026-09-30 23:59:59"), now);
  assert.equal(expired.status === "ok" && expired.currentPrice, "120");
  assert.equal(expired.status === "ok" && expired.regularPrice, null);

  const higher = toNacionalGraphqlPriceResult(item(130, null, null), now);
  assert.equal(higher.status === "ok" && higher.currentPrice, "120");

  const noPrice = toNacionalGraphqlPriceResult({ sku: "1", price_range: null }, now);
  assert.equal(noPrice.status === "error" && noPrice.reason, "price_not_found");
});

async function readBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}

test("sends Magento batches with the store header and SKU list", async () => {
  const seen: Array<{ store: string | undefined; body: { variables: unknown } }> = [];
  let status = 200;
  const server = createServer(async (request, response) => {
    seen.push({
      store: request.headers.store as string | undefined,
      body: JSON.parse(await readBody(request)),
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: {
          products: {
            total_count: 2,
            items: [{ sku: "2010123", price: 1 }, { sku: 2010124 }],
          },
        },
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;

  try {
    const lookup = await fetchMagentoGraphqlItemsBySku({
      url,
      storeCode: "mercajumbo",
      query: "query($skus: [String!]!, $pageSize: Int!) { x }",
      skus: ["2010123", "2010124"],
      itemSchema: z.object({ sku: z.string(), price: z.number() }),
    });

    assert.equal(seen[0].store, "mercajumbo");
    assert.deepEqual(seen[0].body.variables, { skus: ["2010123", "2010124"], pageSize: 2 });
    assert.equal(lookup.ok, true);
    assert.deepEqual(lookup.ok && [...lookup.items], [["2010123", { sku: "2010123", price: 1 }]]);

    status = 403;
    assert.deepEqual(
      await fetchMagentoGraphqlItemsBySku({
        url,
        storeCode: "default",
        query: "",
        skus: ["1"],
        itemSchema: z.object({ sku: z.string() }),
      }),
      { ok: false, reason: "http_403" }
    );
  } finally {
    server.close();
  }
});
