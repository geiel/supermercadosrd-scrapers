import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  fetchSupermixCatalogPage,
  fetchSupermixProduct,
  isLegacySupermixUrl,
  parseSupermixProductId,
  parseSupermixSlug,
  toSupermixPriceResult,
  type SupermixApiConfig,
} from "./shops/supermix.js";

function product(
  price: string | null,
  {
    originalPrice = null,
    inStock = true,
    priceFrom = false,
    slug = "la-garza-arroz-10-lb",
  }: {
    originalPrice?: string | null;
    inStock?: boolean;
    priceFrom?: boolean;
    slug?: string;
  } = {}
) {
  return {
    id: 830781,
    slug,
    title: "LA GARZA ARROZ 10 LB",
    in_stock: inStock,
    pricing: {
      price: price === null ? null : { amount: price, formatted: `RD$ ${price}` },
      original_price:
        originalPrice === null ? null : { amount: originalPrice, formatted: `RD$ ${originalPrice}` },
      price_from: priceFrom,
      on_sale: originalPrice !== null,
      promotion: null,
    },
  };
}

async function withApi(
  handler: (request: IncomingMessage) => { status?: number; headers?: Record<string, string>; json: unknown },
  run: (config: SupermixApiConfig) => Promise<void>
) {
  const server = createServer((request, response) => {
    const reply = handler(request);
    response.writeHead(reply.status ?? 200, {
      "content-type": "application/json",
      ...reply.headers,
    });
    response.end(JSON.stringify(reply.json));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run({ apiBaseUrl: `http://127.0.0.1:${port}/api/storefront/v1`, retryDelayMs: 1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("accepts only numeric Supermix product ids", () => {
  assert.equal(parseSupermixProductId(" 830781 "), "830781");
  assert.equal(parseSupermixProductId("gid://shopify/Product/10210162114741"), null);
  assert.equal(parseSupermixProductId(null), null);
});

test("extracts the slug only from current Supermix product URLs", () => {
  assert.equal(
    parseSupermixSlug("https://supermix.com.do/p/La-Garza-Arroz-10-LB?x=1"),
    "la-garza-arroz-10-lb"
  );
  assert.equal(parseSupermixSlug("https://supermix.com.do/products/capitan-crunch-11-7-oz"), null);
  assert.equal(parseSupermixSlug("https://supermix.com.do/t/arroz-fd2d12bf"), null);
  assert.equal(parseSupermixSlug("https://example.com/p/la-garza-arroz-10-lb"), null);
  assert.equal(parseSupermixSlug("not a url"), null);
});

test("recognizes Shopify-era product URLs as legacy links", () => {
  assert.equal(isLegacySupermixUrl("https://supermix.com.do/products/capitan-crunch-11-7-oz"), true);
  assert.equal(isLegacySupermixUrl("https://supermix.com.do/p/la-garza-arroz-10-lb"), false);
  assert.equal(isLegacySupermixUrl("https://example.com/products/capitan-crunch"), false);
});

test("uses the sale price as current price and the original price as regular price", () => {
  const result = toSupermixPriceResult(product("459.01", { originalPrice: "469.00" }));

  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" && result.currentPrice, "459.01");
  assert.equal(result.status === "ok" && result.regularPrice, "469.00");
  assert.equal(
    result.status === "ok" && result.canonicalUrl,
    "https://supermix.com.do/p/la-garza-arroz-10-lb"
  );
});

test("ignores original prices that are not higher than the price", () => {
  const result = toSupermixPriceResult(product("90", { originalPrice: "90.00" }));

  assert.equal(result.status === "ok" && result.currentPrice, "90.00");
  assert.equal(result.status === "ok" && result.regularPrice, null);
});

test("hides removed, out-of-stock and unpriced products", () => {
  for (const [input, reason] of [
    [null, "product_not_found"],
    [product("90", { inStock: false }), "unavailable"],
    [product(null), "price_not_found"],
    [product("0.00"), "price_not_found"],
  ] as const) {
    const result = toSupermixPriceResult(input);
    assert.equal(result.status, "not_found");
    assert.equal(result.status === "not_found" && result.reason, reason);
    assert.equal(result.status === "not_found" && result.hide, true);
  }
});

test("refuses to guess a price for products priced from several variants", () => {
  const result = toSupermixPriceResult(product("100", { priceFrom: true }));

  assert.equal(result.status, "error");
  assert.equal(result.status === "error" && result.reason, "multiple_variants");
  assert.equal(result.status === "error" && result.hide, true);
});

test("reports an unexpected payload without hiding the price", () => {
  const result = toSupermixPriceResult({ id: "830781", pricing: {} });

  assert.equal(result.status === "error" && result.reason, "invalid_payload");
  assert.equal(result.status === "error" && result.hide, false);
});

test("pages the catalog oldest first, 100 products per request", async () => {
  const urls: string[] = [];

  await withApi(
    (request) => {
      urls.push(request.url ?? "");
      return { json: { products: [product("10")], pagination: { page: 3 } } };
    },
    async (config) => {
      const fetched = await fetchSupermixCatalogPage(3, config);
      assert.equal(fetched.ok, true);
      assert.equal(fetched.ok && fetched.products.length, 1);
    }
  );

  assert.deepEqual(urls, [
    "/api/storefront/v1/products?per_page=100&sort=created_at%3Aasc&page=3",
  ]);
});

test("treats a product 404 as gone, not as a request failure", async () => {
  await withApi(
    () => ({ status: 404, json: { error: "Not found" } }),
    async (config) => {
      assert.deepEqual(await fetchSupermixProduct("old-slug", config), {
        ok: true,
        product: null,
      });
    }
  );
});

test("retries throttled requests and then succeeds", async () => {
  let calls = 0;

  await withApi(
    () => {
      calls += 1;
      return calls === 1
        ? { status: 429, json: {} }
        : { json: product("10") };
    },
    async (config) => {
      const fetched = await fetchSupermixProduct("830781", config);
      assert.equal(fetched.ok, true);
    }
  );

  assert.equal(calls, 2);
});

test("does not retry forbidden requests", async () => {
  let calls = 0;

  await withApi(
    () => {
      calls += 1;
      return { status: 403, json: {} };
    },
    async (config) => {
      assert.deepEqual(await fetchSupermixCatalogPage(1, config), {
        ok: false,
        reason: "http_403",
      });
    }
  );

  assert.equal(calls, 1);
});
