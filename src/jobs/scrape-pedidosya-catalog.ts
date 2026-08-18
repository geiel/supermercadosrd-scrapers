#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_PEDIDOSYA_MENU_URL,
  DEFAULT_PEDIDOSYA_VENDOR_ID,
  scrapePedidosYaCatalog,
  type PedidosYaProduct,
} from "../pedidosya/catalog.js";

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args.set(token, "true");
      continue;
    }

    args.set(token, value);
    index += 1;
  }

  return args;
}

function parsePositiveInteger(
  args: Map<string, string>,
  key: string,
  fallback: number
) {
  const raw = args.get(key);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${key}: ${raw}`);
  }

  return parsed;
}

function parseExtraHeaders() {
  const raw = process.env.PEDIDOSYA_EXTRA_HEADERS_JSON?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PEDIDOSYA_EXTRA_HEADERS_JSON must be a JSON object");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)])
  );
}

function escapeCsv(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function productsToCsv(products: PedidosYaProduct[]) {
  const headers = [
    "external_id",
    "name",
    "current_price",
    "regular_price",
    "gtin",
    "integration_code",
    "legacy_id",
    "image_url",
    "category_ids",
    "category_names",
    "max_quantity",
    "requires_age_check",
  ];
  const rows = products.map((product) => [
    product.externalId,
    product.name,
    product.currentPrice,
    product.regularPrice,
    product.gtin,
    product.integrationCode,
    product.legacyId,
    product.imageUrl,
    product.categoryIds.join("|"),
    product.categoryNames.join("|"),
    product.maxQuantity,
    product.requiresAgeCheck,
  ]);

  return [headers, ...rows]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDirectory = resolve(
    args.get("--output-dir") ?? "artifacts/pedidosya"
  );
  await mkdir(outputDirectory, { recursive: true });

  const result = await scrapePedidosYaCatalog({
    menuUrl: args.get("--url") ?? DEFAULT_PEDIDOSYA_MENU_URL,
    vendorId: args.get("--vendor-id") ?? DEFAULT_PEDIDOSYA_VENDOR_ID,
    pageSize: parsePositiveInteger(args, "--page-size", 20),
    maxPagesPerCategory: parsePositiveInteger(args, "--max-pages", 50),
    timeoutMs: parsePositiveInteger(args, "--timeout", 60_000),
    settleMs: parsePositiveInteger(args, "--settle-ms", 6_000),
    delayMinMs: parsePositiveInteger(args, "--delay-min", 150),
    delayMaxMs: parsePositiveInteger(args, "--delay-max", 350),
    diagnosticDirectory: outputDirectory,
    extraHeaders: parseExtraHeaders(),
    proxyServer: process.env.PEDIDOSYA_PROXY_SERVER?.trim() || null,
    proxyUsername: process.env.PEDIDOSYA_PROXY_USERNAME?.trim() || null,
    proxyPassword: process.env.PEDIDOSYA_PROXY_PASSWORD ?? null,
  });

  await Promise.all([
    writeFile(
      resolve(outputDirectory, "pedidosya-run-report.json"),
      `${JSON.stringify(result.report, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      resolve(outputDirectory, "pedidosya-categories.json"),
      `${JSON.stringify(
        {
          normalized: result.categories,
          raw: result.rawCategories,
        },
        null,
        2
      )}\n`,
      "utf8"
    ),
    writeFile(
      resolve(outputDirectory, "pedidosya-products.json"),
      `${JSON.stringify(result.products, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      resolve(outputDirectory, "pedidosya-products.csv"),
      `${productsToCsv(result.products)}\n`,
      "utf8"
    ),
    result.diagnosticHtml
      ? writeFile(
          resolve(outputDirectory, "pedidosya-diagnostic.html"),
          result.diagnosticHtml,
          "utf8"
        )
      : Promise.resolve(),
  ]);

  console.log(
    `[PEDIDOSYA] status=${result.report.status} categories=${result.report.categoriesFound} products=${result.report.productsFound}`
  );
  console.log(`[PEDIDOSYA] report=${resolve(outputDirectory, "pedidosya-run-report.json")}`);

  if (result.report.status !== "ok") {
    throw new Error(result.report.reason ?? "pedidosya_catalog_failed");
  }
}

void main().catch((error) => {
  console.error(
    "[ERROR] PedidosYa catalog scrape failed",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});

