import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  buildOleProductUrl,
  fetchOleCatalog,
  fetchOleProductDetails,
  isOleSoldByWeight,
  parseOleProductId,
  toOleDetailsPriceResult,
  toOleListingPriceResult,
  type OleApiConfig,
} from "./shops/ole.js";

function listingProduct(
  price: number | null,
  {
    id = 15633,
    oldPrice = null,
    disableBuyButton = false,
    name = "SU CARNES Hamburger de Res 4/1",
    seName = "Sku-15633",
  }: {
    id?: number;
    oldPrice?: number | null;
    disableBuyButton?: boolean;
    name?: string;
    seName?: string;
  } = {}
) {
  return {
    id,
    name,
    se_name: seName,
    sku: "7467054120215",
    product_price: {
      old_price: oldPrice === null ? null : `$${oldPrice}`,
      old_price_value: oldPrice,
      price: price === null ? null : `$${price}`,
      price_value: price,
      disable_buy_button: disableBuyButton,
    },
  };
}

function details(
  price: number | null,
  {
    name = "Chuleta Ahumada Lb",
    allowedQuantities = ["1", "2", "3"],
    disableBuyButton = false,
    oldPrice = null,
  }: {
    name?: string;
    allowedQuantities?: string[];
    disableBuyButton?: boolean;
    oldPrice?: number | null;
  } = {}
) {
  return {
    id: 4147,
    name,
    se_name: "Product-4147",
    sku: "200412500000",
    product_price: {
      price_value: price,
      old_price_value: oldPrice,
      call_for_price: false,
      hide_prices: false,
    },
    add_to_cart: {
      disable_buy_button: disableBuyButton,
      allowed_quantities: allowedQuantities.map((value) => ({ text: value, value })),
    },
  };
}

async function withApi(
  handler: (
    request: IncomingMessage,
    body: unknown
  ) => { status?: number; headers?: Record<string, string>; json: unknown },
  run: (config: OleApiConfig) => Promise<void>
) {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const reply = handler(request, raw ? JSON.parse(raw) : undefined);
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      response.end(JSON.stringify(reply.json));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run({ apiBaseUrl: `http://127.0.0.1:${port}/api-frontend`, retryDelayMs: 1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("parses the Olé product id kept in api", () => {
  assert.equal(parseOleProductId(" 15633 "), "15633");
  assert.equal(parseOleProductId("Sku-15633"), null);
  assert.equal(parseOleProductId(null), null);
});

test("builds the lowercase product page URL the site uses as og:url", () => {
  assert.equal(buildOleProductUrl("Sku-15633"), "https://ecommerce.hiperole.com.do/sku-15633");
});

test("uses price_value as current price and a higher old_price_value as regular price", () => {
  const result = toOleListingPriceResult(listingProduct(389, { oldPrice: 414 }));

  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" && result.currentPrice, "389.00");
  assert.equal(result.status === "ok" && result.regularPrice, "414.00");
  assert.equal(
    result.status === "ok" && result.canonicalUrl,
    "https://ecommerce.hiperole.com.do/sku-15633"
  );
  assert.equal(result.status === "ok" && "purchaseTerms" in result, false);
});

test("ignores old prices that are not higher than the price", () => {
  const result = toOleListingPriceResult(listingProduct(14, { oldPrice: 13 }));

  assert.equal(result.status === "ok" && result.regularPrice, null);
});

test("hides products that cannot be ordered or have no price", () => {
  for (const [input, reason] of [
    [listingProduct(199, { disableBuyButton: true }), "unavailable"],
    [listingProduct(null), "price_not_found"],
    [listingProduct(0), "price_not_found"],
  ] as const) {
    const result = toOleListingPriceResult(input);
    assert.equal(result.status === "not_found" && result.reason, reason);
    assert.equal(result.status === "not_found" && result.hide, true);
  }
});

test("reports an unexpected listing payload without hiding the price", () => {
  const result = toOleListingPriceResult({ id: 1, product_price: {} });

  assert.equal(result.status === "error" && result.reason, "invalid_payload");
  assert.equal(result.status === "error" && result.hide, false);
});

test("tells per-pound products from fixed-weight packs", () => {
  for (const name of [
    "Chuleta Ahumada Lb",
    "Patica D/Cerdo lb",
    "Carne Molida Premium 95/5 Lb",
    "Carne #7 Lb",
    "Escalopines de Cerdo Lb (Deli)",
    "UNIPOLLO Alas Frescas Emp. Lb",
    "Queso Pesto Verde Lb Rueda",
    "Pescado Robalo LB (SIN CABEZA)",
  ]) {
    assert.equal(isOleSoldByWeight(name), true, name);
  }

  for (const name of [
    "CHEF Tocineta Smoke Bacon 1Lb",
    "RICA Mantequilla La Vaquita 1/2 Lb",
    "SOSUA Mantequilla Tarro 1/2 Lb",
    "OLE CAMARON CRUDO 16/20 1 LB",
    "INDUVECA Salami Super Especial 1.47 Lb (AP)",
    "BISONO Arroz Brown Rice 5Lbs",
    "CRISTAL DE CAÑA Azucar Morena 900gr (2 LB)",
    "GOYA Guandules 16oz (1 Lb)",
    "OLE Agua 16oz",
  ]) {
    assert.equal(isOleSoldByWeight(name), false, name);
  }
});

test("prices a per-pound product with its purchase terms from the details", () => {
  const result = toOleDetailsPriceResult(details(127, { allowedQuantities: ["2", "4", "6"] }));

  assert.equal(result.status === "ok" && result.currentPrice, "127.00");
  assert.deepEqual(result.status === "ok" && result.purchaseTerms, {
    mode: "measure",
    unit: "LB",
    minimum: "2",
    increment: "2",
    maximum: "6",
    priceReferenceQuantity: "1",
    source: "ole_product_details",
    evidence: { name: "Chuleta Ahumada Lb", allowedQuantities: [2, 4, 6] },
  });
  assert.equal(
    result.status === "ok" && result.canonicalUrl,
    "https://ecommerce.hiperole.com.do/product-4147"
  );
});

test("refuses uneven per-pound quantities instead of guessing the step", () => {
  const result = toOleDetailsPriceResult(details(127, { allowedQuantities: ["1", "2", "5"] }));

  assert.equal(result.status === "error" && result.reason, "purchase_terms_not_found");
  assert.equal(result.status === "error" && result.hide, false);
});

test("prices fixed-size products from the details without purchase terms", () => {
  const result = toOleDetailsPriceResult(
    details(8, { name: "OLE Agua 16oz", allowedQuantities: [], oldPrice: 10 })
  );

  assert.equal(result.status === "ok" && result.currentPrice, "8.00");
  assert.equal(result.status === "ok" && result.regularPrice, "10.00");
  assert.equal(result.status === "ok" && "purchaseTerms" in result, false);
});

test("hides products that are gone or cannot be ordered in the details", () => {
  for (const [input, reason] of [
    [null, "product_not_found"],
    [details(127, { disableBuyButton: true }), "unavailable"],
    [details(127, { disableBuyButton: true, allowedQuantities: ["1", "2", "5"] }), "unavailable"],
  ] as const) {
    const result = toOleDetailsPriceResult(input);
    assert.equal(result.status === "not_found" && result.reason, reason);
  }
});

test("pages each category with its largest page size and keeps each product once", async () => {
  const requests: string[] = [];

  await withApi(
    (request, body) => {
      if (request.url?.endsWith("/Catalog/GetCatalogRoot")) {
        requests.push(`${request.method} ${request.url}`);
        return { json: [{ id: 27, name: "AGUA Y REFRESCOS" }, { id: 341, name: "NUESTRAS MARCAS" }] };
      }

      const { page_number: page, page_size: size } = body as { page_number: number; page_size: number };
      requests.push(`${request.method} ${request.url} ${page}/${size}`);
      const category = Number(request.url?.split("/").pop());
      const options = category === 341 ? ["3", "6", "9"] : ["15", "25", "50", "75"];
      const served = options.includes(String(size)) ? size : Number(options[1] ?? options[0]);
      const ids = category === 27 ? [[1, 2], [3]] : [[3, 4], [5]];
      const pageIds = ids[page - 1] ?? [];
      return {
        json: {
          catalog_products_model: {
            products: pageIds.map((id) => listingProduct(10, { id })),
            page_size: category === 341 ? 6 : served,
            page_size_options: options.map((value) => ({ value, selected: false })),
            has_next_page: page < ids.length,
            total_items: 3,
          },
        },
      };
    },
    async (config) => {
      const catalog = await fetchOleCatalog(config, async () => {});
      assert.deepEqual([...catalog.productsById.keys()], ["1", "2", "3", "4", "5"]);
      assert.deepEqual(catalog.failures, []);
      assert.equal(catalog.categories, 2);
      assert.equal(catalog.pages, 5);
    }
  );

  assert.deepEqual(requests, [
    "GET /api-frontend/Catalog/GetCatalogRoot",
    "POST /api-frontend/Catalog/GetCategoryProducts/27 1/75",
    "POST /api-frontend/Catalog/GetCategoryProducts/27 2/75",
    "POST /api-frontend/Catalog/GetCategoryProducts/341 1/75",
    "POST /api-frontend/Catalog/GetCategoryProducts/341 1/9",
    "POST /api-frontend/Catalog/GetCategoryProducts/341 2/9",
  ]);
});

test("reports a failed category page instead of treating the category as empty", async () => {
  await withApi(
    (request) =>
      request.url?.endsWith("/Catalog/GetCatalogRoot")
        ? { json: [{ id: 27, name: "AGUA Y REFRESCOS" }] }
        : { status: 403, json: "Forbidden" },
    async (config) => {
      const catalog = await fetchOleCatalog(config, async () => {});
      assert.equal(catalog.productsById.size, 0);
      assert.deepEqual(catalog.failures, ["category_27_page_1:http_403"]);
    }
  );
});

test("treats a product 404 as gone, not as a request failure", async () => {
  await withApi(
    () => ({ status: 404, json: "No product found with the specified id=99999999" }),
    async (config) => {
      assert.deepEqual(await fetchOleProductDetails("99999999", config), {
        ok: true,
        details: null,
      });
    }
  );
});

test("retries throttled requests and sends the SupermercadosRD user agent", async () => {
  const agents: string[] = [];

  await withApi(
    (request) => {
      agents.push(request.headers["user-agent"] ?? "");
      return agents.length === 1
        ? { status: 429, json: {} }
        : { json: { product_details_model: details(127) } };
    },
    async (config) => {
      const fetched = await fetchOleProductDetails("4147", config);
      assert.equal(fetched.ok, true);
    }
  );

  assert.equal(agents.length, 2);
  assert.match(agents[0], /SupermercadosRD-PriceSync\/1\.0/);
});
