#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { applyScrapeResult, type ShopPriceRow } from "../db/apply-scrape-result.js";
import { closeDb, db } from "../db/client.js";
import { products, productsShopsPrices } from "../db/schema.js";
import { error } from "../result.js";
import {
  OLE_PURCHASE_TERMS_SOURCE,
  OLE_SHOP_ID,
  extractOlePurchaseTerms,
  fetchOleCatalog,
  fetchOleProductDetails,
  getOleApiConfig,
  isOleSoldByWeight,
  parseOleProductId,
  toOleDetailsPriceResult,
  toOleListingPriceResult,
  type OleProductDetails,
} from "../shops/ole.js";
import type { ScrapePriceResult } from "../types.js";
import { mapWithConcurrency, randomDelay } from "../utils.js";

// Refreshes every Olé price (visible and hidden) by paging through the root
// categories of the app's catalog API (~170 requests at 75 products per page),
// then looks up only the products missing from the listing. It runs on its own
// schedule and never touches the shared prices batch, so other shops are
// unaffected.

// The catalog had 5,920 products on 2026-10-19; far fewer means the listing
// broke, and rows missing from it must not be hidden on that evidence.
const MIN_CATALOG_PRODUCTS = 5000;

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args.set(token, "true");
      continue;
    }

    args.set(token, value);
    i += 1;
  }

  return args;
}

function parseNumberArg(args: Map<string, string>, key: string, fallback: number) {
  const raw = args.get(key);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value for ${key}: ${raw}`);
  }

  return parsed;
}

function parseOptionalIntegerArg(args: Map<string, string>, key: string) {
  const raw = args.get(key);
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer value for ${key}: ${raw}`);
  }

  return parsed;
}

const productIsActive = or(isNull(products.deleted), eq(products.deleted, false));

async function loadOleRows(productId: number | null, limit: number | null) {
  const query = db
    .select({
      productId: productsShopsPrices.productId,
      shopId: productsShopsPrices.shopId,
      url: productsShopsPrices.url,
      api: productsShopsPrices.api,
      locationId: productsShopsPrices.locationId,
      currentPrice: productsShopsPrices.currentPrice,
      regularPrice: productsShopsPrices.regularPrice,
      purchaseMode: productsShopsPrices.purchaseMode,
      purchaseUnit: productsShopsPrices.purchaseUnit,
      minimumPurchaseQuantity: productsShopsPrices.minimumPurchaseQuantity,
      purchaseQuantityIncrement: productsShopsPrices.purchaseQuantityIncrement,
      maximumPurchaseQuantity: productsShopsPrices.maximumPurchaseQuantity,
      priceReferenceQuantity: productsShopsPrices.priceReferenceQuantity,
      purchaseTermsSource: productsShopsPrices.purchaseTermsSource,
      updateAt: productsShopsPrices.updateAt,
      hidden: productsShopsPrices.hidden,
    })
    .from(productsShopsPrices)
    .innerJoin(products, eq(productsShopsPrices.productId, products.id))
    .where(
      and(
        eq(productsShopsPrices.shopId, OLE_SHOP_ID),
        productIsActive,
        productId === null ? undefined : eq(productsShopsPrices.productId, productId)
      )
    )
    .orderBy(sql`${productsShopsPrices.updateAt} asc nulls first`, asc(productsShopsPrices.productId));

  return (limit === null ? await query : await query.limit(limit)) as ShopPriceRow[];
}

async function findStaleVisibleRows(maxAgeHours: number) {
  return db
    .select({
      productId: productsShopsPrices.productId,
      url: productsShopsPrices.url,
      updateAt: productsShopsPrices.updateAt,
    })
    .from(productsShopsPrices)
    .innerJoin(products, eq(productsShopsPrices.productId, products.id))
    .where(
      and(
        eq(productsShopsPrices.shopId, OLE_SHOP_ID),
        productIsActive,
        or(isNull(productsShopsPrices.hidden), eq(productsShopsPrices.hidden, false)),
        or(
          isNull(productsShopsPrices.updateAt),
          sql`${productsShopsPrices.updateAt} < now() - (${maxAgeHours}::float8 * interval '1 hour')`
        )
      )
    )
    .orderBy(sql`${productsShopsPrices.updateAt} asc nulls first`);
}

function describeResult(result: ScrapePriceResult) {
  return result.status === "ok" ? "ok" : `${result.status}:${result.reason}`;
}

function writeStepSummary(lines: string[]) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${lines.join("\n")}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.get("--dry-run") === "true";
  const delayMinMs = parseNumberArg(args, "--delay-min", 1000);
  const delayMaxMs = parseNumberArg(args, "--delay-max", 1500);
  const maxAgeHours = parseNumberArg(args, "--max-age-hours", 12);
  const concurrency = parseNumberArg(args, "--concurrency", 4);
  const maxLookups = parseNumberArg(args, "--max-lookups", 300);
  const targetProductId = parseOptionalIntegerArg(args, "--product-id");
  const limit = parseOptionalIntegerArg(args, "--limit");
  const partialRun = targetProductId !== null || limit !== null;

  const config = getOleApiConfig();
  const rows = await loadOleRows(targetProductId, limit);
  console.log(`[INFO] ole rows=${rows.length}${dryRun ? " (dry run: no database writes)" : ""}`);

  const results = new Map<ShopPriceRow, ScrapePriceResult>();
  const requestFailures: string[] = [];
  let requestCount = 0;

  async function paceRequest() {
    if (requestCount > 0) {
      await randomDelay(delayMinMs, delayMaxMs);
    }

    requestCount += 1;
  }

  const references = new Map<ShopPriceRow, string>();
  for (const row of rows) {
    const id = parseOleProductId(row.api);
    if (id) {
      references.set(row, id);
    } else {
      results.set(row, error(OLE_SHOP_ID, "missing_product_reference", false, false));
    }
  }

  let productsById = new Map<string, unknown>();
  let catalogComplete = false;
  let catalogPages = 0;
  let catalogCategories = 0;

  // A one-product run looks the product up directly instead of paging the catalog.
  if (targetProductId === null && references.size > 0) {
    const catalog = await fetchOleCatalog(config, paceRequest, (category, pages, listed) =>
      console.log(`[CATALOG] category=${category.id} "${category.name}" pages=${pages} products=${listed}`)
    );
    productsById = catalog.productsById;
    catalogPages = catalog.pages;
    catalogCategories = catalog.categories;
    requestFailures.push(...catalog.failures);
    catalogComplete = catalog.failures.length === 0 && productsById.size >= MIN_CATALOG_PRODUCTS;
    if (catalog.failures.length === 0 && !catalogComplete) {
      requestFailures.push(`catalog_too_small:${productsById.size}`);
    }
  }

  // Per-pound products need their purchase terms (minimum and step in pounds),
  // which only the product details carry. They are fetched once per link; later
  // runs keep the saved terms.
  let termLookups = 0;
  const missing: ShopPriceRow[] = [];
  for (const [row, id] of references) {
    const product = productsById.get(id);
    if (!product) {
      missing.push(row);
      continue;
    }

    const name = (product as { name?: unknown }).name;
    const needsTerms =
      typeof name === "string" &&
      isOleSoldByWeight(name) &&
      row.purchaseTermsSource !== OLE_PURCHASE_TERMS_SOURCE;
    if (!needsTerms) {
      results.set(row, toOleListingPriceResult(product));
      continue;
    }

    termLookups += 1;
    await paceRequest();
    const fetched = await fetchOleProductDetails(id, config);
    if (!fetched.ok) {
      requestFailures.push(fetched.reason);
      results.set(row, error(OLE_SHOP_ID, fetched.reason, true, false));
      continue;
    }

    // The listing price stays authoritative; the details only add the terms.
    const terms = fetched.details
      ? extractOlePurchaseTerms(fetched.details as OleProductDetails)
      : undefined;
    results.set(
      row,
      terms
        ? toOleListingPriceResult(product, terms)
        : error(OLE_SHOP_ID, "purchase_terms_not_found", false, false)
    );
  }

  // Products that left the listing are looked up one by one, so a visible
  // price is hidden only when Olé says the product is gone or cannot be
  // ordered. Rows already hidden stay hidden without a request.
  let lookups = 0;
  for (const row of missing) {
    if (catalogComplete && row.hidden) {
      results.set(row, toOleDetailsPriceResult(null));
      continue;
    }

    if (lookups >= maxLookups) {
      results.set(row, error(OLE_SHOP_ID, "lookup_limit_reached", true, false));
      continue;
    }

    lookups += 1;
    await paceRequest();
    const fetched = await fetchOleProductDetails(references.get(row)!, config);
    if (!fetched.ok) {
      requestFailures.push(fetched.reason);
      results.set(row, error(OLE_SHOP_ID, fetched.reason, true, false));
      continue;
    }

    results.set(row, toOleDetailsPriceResult(fetched.details));
  }

  const outcomeCounts = new Map<string, number>();
  for (const result of results.values()) {
    const key = describeResult(result);
    outcomeCounts.set(key, (outcomeCounts.get(key) ?? 0) + 1);
  }

  if (dryRun) {
    for (const [row, result] of results) {
      console.log(
        `[DRY RUN] productId=${row.productId} api=${row.api} ${describeResult(result)}` +
          (result.status === "ok"
            ? ` currentPrice=${result.currentPrice} regularPrice=${result.regularPrice ?? "-"} previous=${row.currentPrice ?? "-"}/${row.regularPrice ?? "-"}` +
              (result.purchaseTerms
                ? ` terms=${result.purchaseTerms.mode}:${result.purchaseTerms.unit}:min${result.purchaseTerms.minimum}:step${result.purchaseTerms.increment}`
                : "")
            : "")
      );
    }
  } else {
    // Hiding an already hidden price changes nothing but would revalidate the page.
    const changes = [...results.entries()].filter(
      ([row, result]) => !(row.hidden && result.status !== "ok" && result.hide)
    );
    await mapWithConcurrency(changes, concurrency, ([row, result]) =>
      applyScrapeResult(row, result)
    );
  }

  const errorCount = [...results.values()].filter((result) => result.status === "error").length;
  const staleRows = dryRun || partialRun ? [] : await findStaleVisibleRows(maxAgeHours);

  const summary = [
    "### Olé price sync",
    "",
    `- Rows: ${rows.length}`,
    `- Requests: ${requestCount} (${catalogCategories} categories, ${catalogPages} catalog pages, ${productsById.size} catalog products, ${termLookups} purchase-term lookups, ${lookups} lookups)`,
    `- Catalog complete: ${targetProductId === null ? (catalogComplete ? "yes" : "no (missing rows were looked up, not hidden)") : "not fetched"}`,
    `- Request failures: ${requestFailures.length}${requestFailures.length ? ` (${requestFailures.join(", ")})` : ""}`,
    ...[...outcomeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, count]) => `- ${outcome}: ${count}`),
    `- Visible prices older than ${maxAgeHours}h: ${dryRun || partialRun ? "not checked" : staleRows.length}`,
  ];
  console.log(summary.join("\n"));
  writeStepSummary(summary);

  for (const row of staleRows.slice(0, 20)) {
    console.error(
      `[STALE] productId=${row.productId} updateAt=${row.updateAt?.toISOString() ?? "never"} url=${row.url}`
    );
  }

  if (requestFailures.length > 0 || errorCount > 0 || staleRows.length > 0) {
    throw new Error(
      `Olé sync needs attention: requestFailures=${requestFailures.length} errors=${errorCount} stale=${staleRows.length}`
    );
  }
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[ERROR] ole price sync failed", err);
    await closeDb();
    process.exit(1);
  });
