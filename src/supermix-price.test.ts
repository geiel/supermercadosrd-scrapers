import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  fetchSupermixNodes,
  parseSupermixGid,
  parseSupermixHandle,
  resolveSupermixHandles,
  toSupermixPriceResult,
  type SupermixStorefrontConfig,
} from "./shops/supermix.js";

function productNode(
  variants: Array<{ price: string; compareAt?: string | null; available?: boolean }>,
  handle = "capitan-crunch-11-7-oz"
) {
  return {
    __typename: "Product",
    id: "gid://shopify/Product/10210162114741",
    handle,
    variants: {
      nodes: variants.map((variant, index) => ({
        id: `gid://shopify/ProductVariant/5158382341343${index}`,
        availableForSale: variant.available ?? true,
        price: { amount: variant.price },
        compareAtPrice:
          variant.compareAt === undefined || variant.compareAt === null
            ? null
            : { amount: variant.compareAt },
      })),
    },
  };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

async function withStorefront(
  handler: (
    body: { query: string; variables: Record<string, unknown> },
    request: IncomingMessage
  ) => { status?: number; headers?: Record<string, string>; json: unknown },
  run: (config: SupermixStorefrontConfig) => Promise<void>
) {
  const server = createServer(async (request, response) => {
    const reply = handler(await readBody(request), request);
    response.writeHead(reply.status ?? 200, {
      "content-type": "application/json",
      ...reply.headers,
    });
    response.end(JSON.stringify(reply.json));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run({
      apiUrl: `http://127.0.0.1:${port}/api/2026-07/graphql.json`,
      accessToken: "public-token",
      retryDelayMs: 1,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("parses Supermix product and variant GIDs", () => {
  assert.deepEqual(parseSupermixGid("gid://shopify/Product/10210162114741"), {
    gid: "gid://shopify/Product/10210162114741",
    type: "Product",
    id: "10210162114741",
  });
  assert.equal(
    parseSupermixGid(" gid://shopify/ProductVariant/51583823413429 ")?.type,
    "ProductVariant"
  );
  assert.equal(parseSupermixGid("https://supermix.com.do/products/x.js"), null);
  assert.equal(parseSupermixGid(null), null);
});

test("extracts the handle only from Supermix product URLs", () => {
  assert.equal(
    parseSupermixHandle("https://supermix.com.do/products/Jaja-Petit-Pois-15-Oz?variant=1"),
    "jaja-petit-pois-15-oz"
  );
  assert.equal(
    parseSupermixHandle("https://supermix.com.do/collections/alimentos/products/goya-15-oz/"),
    "goya-15-oz"
  );
  assert.equal(parseSupermixHandle("https://jumbo.com.do/products/goya-15-oz"), null);
  assert.equal(parseSupermixHandle("https://supermix.com.do/collections/alimentos"), null);
});

test("uses the sale price as current price and compare-at as regular price", () => {
  const result = toSupermixPriceResult(
    productNode([{ price: "3611.65", compareAt: "4249.0" }], "tequila-1800-cristalino")
  );

  assert.equal(result.status, "ok");
  assert.equal(result.shopId, 14);
  assert.equal(result.shopName, "supermix");
  if (result.status === "ok") {
    assert.equal(result.currentPrice, "3611.65");
    assert.equal(result.regularPrice, "4249.00");
    assert.equal(
      result.canonicalUrl,
      "https://supermix.com.do/products/tequila-1800-cristalino"
    );
  }
});

test("ignores compare-at prices that are not higher than the price", () => {
  for (const compareAt of [null, "245.0", "200.0"]) {
    const result = toSupermixPriceResult(productNode([{ price: "245.0", compareAt }]));
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.currentPrice, "245.00");
      assert.equal(result.regularPrice, null);
    }
  }
});

test("hides deleted, unpublished and out-of-stock products", () => {
  assert.deepEqual(toSupermixPriceResult(null), {
    status: "not_found",
    shopId: 14,
    shopName: "supermix",
    reason: "product_not_found",
    hide: true,
  });

  const unavailable = toSupermixPriceResult(
    productNode([{ price: "99.0", available: false }])
  );
  assert.equal(unavailable.status, "not_found");
  assert.equal(unavailable.status === "not_found" && unavailable.hide, true);

  const zeroPrice = toSupermixPriceResult(productNode([{ price: "0.0" }]));
  assert.equal(zeroPrice.status === "not_found" && zeroPrice.reason, "price_not_found");
});

test("refuses to guess a price for multi-variant products", () => {
  const result = toSupermixPriceResult(
    productNode([{ price: "150.0" }, { price: "190.0" }])
  );

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.reason, "multiple_variants");
    assert.equal(result.retryable, false);
    assert.equal(result.hide, true);
  }
});

test("prices a specific variant when api holds a variant GID", () => {
  const result = toSupermixPriceResult({
    __typename: "ProductVariant",
    id: "gid://shopify/ProductVariant/51583823413429",
    availableForSale: true,
    price: { amount: "150.0" },
    compareAtPrice: null,
    product: { handle: "destornillador-de-estria" },
  });

  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(
      result.canonicalUrl,
      "https://supermix.com.do/products/destornillador-de-estria?variant=51583823413429"
    );
  }
});

test("reports an unexpected payload without hiding the price", () => {
  const result = toSupermixPriceResult({ __typename: "Collection", id: "x" });
  assert.equal(result.status, "error");
  assert.equal(result.status === "error" && result.hide, false);
});

test("fetches a batch of nodes in one request and keeps them aligned by GID", async () => {
  const requests: Array<{ token: string | undefined; ids: unknown }> = [];

  await withStorefront(
    (body, request) => {
      requests.push({
        token: request.headers["x-shopify-storefront-access-token"] as string | undefined,
        ids: body.variables.ids,
      });
      const ids = body.variables.ids as string[];
      return {
        headers: { "x-shopify-api-version": "2026-07" },
        json: {
          data: {
            nodes: ids.map((id) =>
              id.endsWith("/1") ? null : { ...productNode([{ price: "95.0" }]), id }
            ),
          },
        },
      };
    },
    async (config) => {
      const gids = ["gid://shopify/Product/10", "gid://shopify/Product/1"];
      const result = await fetchSupermixNodes(gids, config);

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.apiVersion, "2026-07");
        assert.equal(toSupermixPriceResult(result.nodesByGid.get(gids[0])).status, "ok");
        assert.equal(result.nodesByGid.get(gids[1]), null);
      }
    }
  );

  assert.deepEqual(requests, [
    {
      token: "public-token",
      ids: ["gid://shopify/Product/10", "gid://shopify/Product/1"],
    },
  ]);
});

test("retries throttled requests and then succeeds", async () => {
  let calls = 0;

  await withStorefront(
    () => {
      calls += 1;
      return calls === 1
        ? { status: 429, json: { errors: "Throttled" } }
        : { json: { data: { nodes: [null] } } };
    },
    async (config) => {
      const result = await fetchSupermixNodes(["gid://shopify/Product/1"], config);
      assert.equal(result.ok, true);
    }
  );

  assert.equal(calls, 2);
});

test("does not retry authentication failures", async () => {
  let calls = 0;

  await withStorefront(
    () => {
      calls += 1;
      return { status: 401, json: { errors: "Unauthorized" } };
    },
    async (config) => {
      const result = await fetchSupermixNodes(["gid://shopify/Product/1"], config);
      assert.deepEqual(result, { ok: false, reason: "http_401" });
    }
  );

  assert.equal(calls, 1);
});

test("resolves product handles to GIDs with one aliased query", async () => {
  let receivedQuery = "";

  await withStorefront(
    (body) => {
      receivedQuery = body.query;
      assert.deepEqual(body.variables, { h0: "goya-15-oz", h1: "missing" });
      return {
        json: { data: { h0: { id: "gid://shopify/Product/42" }, h1: null } },
      };
    },
    async (config) => {
      const result = await resolveSupermixHandles(["goya-15-oz", "missing"], config);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.gidByHandle.get("goya-15-oz"), "gid://shopify/Product/42");
        assert.equal(result.gidByHandle.get("missing"), null);
      }
    }
  );

  assert.match(receivedQuery, /h0: product\(handle: \$h0\)/);
});
