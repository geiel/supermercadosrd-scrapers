import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

for (const name of [
  "SIRENA_PRODUCT_API_URL_TEMPLATE",
  "SIRENA_PRODUCTS_SEARCH_API_URL",
  "SIRENA_CATEGORY_TREE_API_URL_TEMPLATE",
  "PLAZA_LAMA_GRAPHQL_URL",
  "PLAZA_LAMA_DPL_API_KEY",
  "PRICESMART_PRODUCT_API_URL",
  "PRICESMART_DISCOVERY_API_URL",
]) {
  process.env[name] ??= "https://example.com";
}

test("uses Nacional REST lookup for regular and active special prices", async () => {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(requestUrl);

    const sku = requestUrl.searchParams.get(
      "searchCriteria[filter_groups][0][filters][0][value]"
    );
    if (sku === "2800472") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }

    const websiteIds = sku === "2800470" ? [2] : [1];
    const specialToDate =
      sku === "2800471" ? "2021-12-31 23:59:59" : "2099-12-31 23:59:59";

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        items: [
          {
            sku,
            status: 1,
            price: "500",
            extension_attributes: { website_ids: websiteIds },
            custom_attributes: [
              { attribute_code: "special_price", value: "450" },
              {
                attribute_code: "special_from_date",
                value: "2020-01-01 00:00:00",
              },
              {
                attribute_code: "special_to_date",
                value: specialToDate,
              },
            ],
          },
        ],
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.NACIONAL_REST_API_URL = `http://127.0.0.1:${address.port}/products`;

  try {
    const { scrapeNacionalPrice } = await import("./shops/nacional.js");
    const result = await scrapeNacionalPrice(
      {
        shopId: 2,
        url: "https://supermercadosnacional.com/producto-2800469",
      },
      { maxRetries: 1, timeoutMs: 1000 }
    );

    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.currentPrice, "450");
      assert.equal(result.regularPrice, "500");
      assert.equal(result.purchaseTerms, undefined);
    }

    assert.equal(requests.length, 1);
    assert.equal(requests[0].pathname, "/products");
    assert.equal(
      requests[0].searchParams.get(
        "searchCriteria[filter_groups][0][filters][0][condition_type]"
      ),
      "eq"
    );
    assert.match(requests[0].searchParams.get("fields") ?? "", /website_ids/);

    const foreignWebsiteResult = await scrapeNacionalPrice(
      {
        shopId: 2,
        url: "https://supermercadosnacional.com/producto-2800470",
      },
      { maxRetries: 1, timeoutMs: 1000 }
    );
    assert.equal(foreignWebsiteResult.status, "not_found");

    const expiredSpecialResult = await scrapeNacionalPrice(
      {
        shopId: 2,
        url: "https://supermercadosnacional.com/producto-2800471",
      },
      { maxRetries: 1, timeoutMs: 1000 }
    );
    assert.equal(expiredSpecialResult.status, "ok");
    if (expiredSpecialResult.status === "ok") {
      assert.equal(expiredSpecialResult.currentPrice, "500");
      assert.equal(expiredSpecialResult.regularPrice, null);
    }

    const invalidPayloadResult = await scrapeNacionalPrice(
      {
        shopId: 2,
        url: "https://supermercadosnacional.com/producto-2800472",
      },
      { maxRetries: 1, timeoutMs: 1000 }
    );
    assert.equal(invalidPayloadResult.status, "error");
    if (invalidPayloadResult.status === "error") {
      assert.equal(invalidPayloadResult.reason, "invalid_payload");
      assert.equal(invalidPayloadResult.hide, false);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
