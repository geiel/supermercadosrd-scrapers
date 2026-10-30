import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadSupermixCatalog, loadSupermixVariants } from "./supermix-sync.js";
import type { SupermixApiConfig } from "./shops/supermix.js";

const noDelay = async () => {};
const item = (id: number) => ({ id, slug: `product-${id}` });

async function withApi(
  reply: (url: URL) => { status?: number; body: unknown },
  run: (config: SupermixApiConfig) => Promise<void>
) {
  const server = createServer((req, res) => {
    const response = reply(new URL(req.url!, "http://localhost"));
    res.writeHead(response.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ apiBaseUrl: `http://127.0.0.1:${port}`, maxAttempts: 1 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

function catalog(products: unknown[], current: string | null = "created_at:asc") {
  return {
    body: { products, sort: { current }, pagination: { total_pages: 1, total_count: 1 } },
  };
}

test("traverses beyond advertised totals and short pages until a real empty page", async () => {
  const pages: number[] = [];
  let paced = 0;
  await withApi(
    (url) => {
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      return catalog(page < 3 ? [item(page)] : []);
    },
    async (config) => {
      const result = await loadSupermixCatalog(config, async () => { paced += 1; }, { minProducts: 2 });
      assert.equal(result.productsById.size, 2);
      assert.equal(result.productsBySlug.get("product-2"), result.productsById.get("2"));
      assert.equal(result.pages, 3);
    }
  );
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(paced, 3);
});

test("rejects repeated pages and partial overlap instead of accepting reduced coverage", async () => {
  for (const secondPage of [[item(1), item(2)], [item(2), item(3)]]) {
    await withApi(
      (url) => catalog(Number(url.searchParams.get("page")) === 1 ? [item(1), item(2)] : secondPage),
      async (config) => {
        await assert.rejects(
          loadSupermixCatalog(config, noDelay, { minProducts: 1 }),
          /catalog_page_2:duplicate_product_id:/
        );
      }
    );
  }
});

test("rejects duplicates within a single page", async () => {
  await withApi(
    () => catalog([item(1), item(1)]),
    async (config) => {
      await assert.rejects(loadSupermixCatalog(config, noDelay), /duplicate_product_id:1/);
    }
  );
});

test("rejects truncated, malformed, unsorted and unbounded catalogs", async () => {
  for (const [reply, options, reason] of [
    [() => catalog([]), { minProducts: 2 }, /catalog_too_small:0/],
    [() => catalog([{ slug: "missing-id" }]), {}, /invalid_product_reference/],
    [() => catalog([item(1)], null), {}, /catalog_sort_not_applied/],
    [(url: URL) => catalog([item(Number(url.searchParams.get("page")))]), { maxPages: 2 }, /catalog_page_limit_reached:2/],
    [() => ({ status: 503, body: {} }), {}, /catalog_page_1:http_503/],
  ] as const) {
    await withApi(reply, async (config) => {
      await assert.rejects(loadSupermixCatalog(config, noDelay, options), reason);
    });
  }
});

const variantDetail = {
  slug: "absent-from-catalog",
  variants: [
    { id: 11, in_stock: true, pricing: { price: { amount: "65.00" }, original_price: null } },
    { id: 12, in_stock: false, pricing: { price: { amount: "70.00" }, original_price: null } },
  ],
};

test("fetches variants absent from a complete catalog once per parent product", async () => {
  const requests: string[] = [];
  await withApi(
    (url) => {
      requests.push(url.pathname);
      if (url.pathname === "/products/99") return { body: variantDetail };
      return catalog(Number(url.searchParams.get("page")) === 1 ? [item(1)] : []);
    },
    async (config) => {
      const listing = await loadSupermixCatalog(config, noDelay, { minProducts: 1 });
      assert.equal(listing.productsById.has("99"), false);
      const detail = await loadSupermixVariants(new Map([["99", new Set(["11", "12", "13"])]]), config, noDelay);
      assert.deepEqual(detail.requestFailures, []);
      assert.equal(detail.requests, 1);
      const available = detail.results.get("99:11")!;
      assert.equal(available.status === "ok" && available.currentPrice, "65.00");
      for (const [ref, reason] of [["99:12", "unavailable"], ["99:13", "variant_not_found"]]) {
        const result = detail.results.get(ref)!;
        assert.equal(result.status === "not_found" && result.reason, reason);
        assert.equal(result.status !== "ok" && result.hide, true);
      }
    }
  );
  assert.equal(requests.filter((path) => path === "/products/99").length, 1);
});

test("hides variants only on confirmed absence; request failures preserve prices", async () => {
  for (const status of [404, 403, 503]) {
    await withApi(
      () => ({ status, body: {} }),
      async (config) => {
        const detail = await loadSupermixVariants(new Map([["99", new Set(["11"])]]), config, noDelay);
        const result = detail.results.get("99:11")!;
        assert.equal(result.status, status === 404 ? "not_found" : "error");
        assert.equal(result.hide, status === 404);
        assert.equal(detail.requestFailures.length, status === 404 ? 0 : 1);
      }
    );
  }
});
