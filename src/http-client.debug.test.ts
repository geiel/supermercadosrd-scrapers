import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

for (const name of [
  "SIRENA_PRODUCT_API_URL_TEMPLATE",
  "SIRENA_PRODUCTS_SEARCH_API_URL",
  "SIRENA_CATEGORY_TREE_API_URL_TEMPLATE",
  "NACIONAL_REST_API_URL",
  "PLAZA_LAMA_GRAPHQL_URL",
  "PLAZA_LAMA_DPL_API_KEY",
  "PRICESMART_PRODUCT_API_URL",
  "PRICESMART_DISCOVERY_API_URL",
]) {
  process.env[name] ??= "https://example.com";
}

async function withMockServer(
  run: (baseUrl: string) => Promise<void>
) {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://example.com/outside" });
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end("áááá");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

test("rejects a redirect before following it outside the callback allowlist", async () => {
  const { fetchWithRetryDetailed } = await import("./http-client.js");

  await withMockServer(async (baseUrl) => {
    const result = await fetchWithRetryDetailed(
      `${baseUrl}/redirect`,
      {},
      {
        maxRetries: 0,
        isUrlAllowed: (url) => url.startsWith(baseUrl),
      }
    );

    assert.equal(result.response, null);
    assert.equal(result.failureReason, "request_aborted");
  });
});

test("limits diagnostic bodies by UTF-8 byte size and marks truncation", async () => {
  const { fetchWithRetryDetailed } = await import("./http-client.js");

  await withMockServer(async (baseUrl) => {
    let observedBody: string | null = null;
    let observedTruncated = false;
    const result = await fetchWithRetryDetailed(
      `${baseUrl}/body`,
      {},
      {
        maxRetries: 0,
        debugBodyLimitBytes: 5,
        onResponse: (exchange) => {
          observedBody = exchange.body;
          observedTruncated = exchange.truncated;
        },
      }
    );

    assert.ok(result.response);
    assert.equal(observedTruncated, true);
    assert.ok(new TextEncoder().encode(observedBody ?? "").length <= 5);
  });
});
