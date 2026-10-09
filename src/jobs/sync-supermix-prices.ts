#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { applyScrapeResult, type ShopPriceRow } from "../db/apply-scrape-result.js";
import { closeDb, db } from "../db/client.js";
import { products, productsShopsPrices } from "../db/schema.js";
import { error, notFound } from "../result.js";
import {
  SUPERMIX_SHOP_ID,
  fetchSupermixCatalogPage,
  fetchSupermixProduct,
  getSupermixApiConfig,
  isLegacySupermixUrl,
  parseSupermixReference,
  parseSupermixSlug,
  toSupermixPriceResult,
} from "../shops/supermix.js";
import type { ScrapePriceResult } from "../types.js";
import { mapWithConcurrency, randomDelay } from "../utils.js";

// Refreshes every Supermix price (visible and hidden) by paging through the
// public catalog API (~210 requests), then looks up only the products missing
// from the listing. It runs on its own schedule and never touches the shared
// prices batch, so other shops are unaffected.

// A real catalog has ~20k products; far fewer means the listing broke, and
// rows missing from it must not be hidden on that evidence.
const MIN_CATALOG_PRODUCTS = 5000;
const MAX_CATALOG_PAGES = 1000;

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

async function loadSupermixRows(productId: number | null, limit: number | null) {
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
        eq(productsShopsPrices.shopId, SUPERMIX_SHOP_ID),
        productIsActive,
        productId === null ? undefined : eq(productsShopsPrices.productId, productId)
      )
    )
    .orderBy(sql`${productsShopsPrices.updateAt} asc nulls first`, asc(productsShopsPrices.productId));

  return (limit === null ? await query : await query.limit(limit)) as ShopPriceRow[];
}

async function persistProductId(row: ShopPriceRow, id: string) {
  await db
    .update(productsShopsPrices)
    .set({ api: id })
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        eq(productsShopsPrices.shopId, SUPERMIX_SHOP_ID),
        sql`${productsShopsPrices.api} IS DISTINCT FROM ${id}`
      )
    );
}

function productIdOf(product: unknown) {
  const id = (product as { id?: unknown } | null)?.id;
  return typeof id === "number" ? String(id) : null;
}

function productSlugOf(product: unknown) {
  const slug = (product as { slug?: unknown } | null)?.slug;
  return typeof slug === "string" ? slug.toLowerCase() : null;
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
        eq(productsShopsPrices.shopId, SUPERMIX_SHOP_ID),
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
  const delayMinMs = parseNumberArg(args, "--delay-min", 1500);
  const delayMaxMs = parseNumberArg(args, "--delay-max", 3000);
  const maxAgeHours = parseNumberArg(args, "--max-age-hours", 12);
  const concurrency = parseNumberArg(args, "--concurrency", 4);
  const maxLookups = parseNumberArg(args, "--max-lookups", 300);
  const targetProductId = parseOptionalIntegerArg(args, "--product-id");
  const limit = parseOptionalIntegerArg(args, "--limit");
  const partialRun = targetProductId !== null || limit !== null;

  const config = getSupermixApiConfig();
  const rows = await loadSupermixRows(targetProductId, limit);
  console.log(
    `[INFO] supermix rows=${rows.length}${dryRun ? " (dry run: no database writes)" : ""}`
  );

  const results = new Map<ShopPriceRow, ScrapePriceResult>();
  const requestFailures: string[] = [];
  let requestCount = 0;

  async function paceRequest() {
    if (requestCount > 0) {
      await randomDelay(delayMinMs, delayMaxMs);
    }

    requestCount += 1;
  }

  type Reference = { id: string | null; variantId: string | null; slug: string | null };
  const references = new Map<ShopPriceRow, Reference>();
  for (const row of rows) {
    const parsed = parseSupermixReference(row.api);
    const reference = {
      id: parsed?.productId ?? null,
      variantId: parsed?.variantId ?? null,
      slug: parseSupermixSlug(row.url),
    };
    if (reference.id || reference.slug) {
      references.set(row, reference);
    } else if (isLegacySupermixUrl(row.url)) {
      results.set(row, notFound(SUPERMIX_SHOP_ID, "legacy_shopify_link", true));
    } else {
      results.set(row, error(SUPERMIX_SHOP_ID, "missing_product_reference", false, false));
    }
  }

  const productsById = new Map<string, unknown>();
  const productsBySlug = new Map<string, unknown>();
  let catalogComplete = false;
  let catalogPages = 0;

  // A one-product run looks the product up directly instead of paging the catalog.
  if (targetProductId === null) {
    for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
      await paceRequest();
      const fetched = await fetchSupermixCatalogPage(page, config);
      if (!fetched.ok) {
        requestFailures.push(`catalog_page_${page}:${fetched.reason}`);
        break;
      }

      catalogPages = page;
      if (fetched.products.length === 0) {
        catalogComplete = productsById.size >= MIN_CATALOG_PRODUCTS;
        if (!catalogComplete) {
          requestFailures.push(`catalog_too_small:${productsById.size}`);
        }
        break;
      }

      for (const product of fetched.products) {
        const id = productIdOf(product);
        const slug = productSlugOf(product);
        if (id) productsById.set(id, product);
        if (slug) productsBySlug.set(slug, product);
      }
    }
  }

  // The listing only shows a "desde" price for products with variants, so each
  // such product is fetched once and every linked variant is priced from it.
  const variantRows = new Map<string, ShopPriceRow[]>();
  for (const [row, { id, variantId }] of references) {
    if (id && variantId) {
      variantRows.set(id, [...(variantRows.get(id) ?? []), row]);
      references.delete(row);
    }
  }

  let variantLookups = 0;
  for (const [id, linkedRows] of variantRows) {
    let product: unknown = null;
    if (!catalogComplete || productsById.has(id)) {
      variantLookups += 1;
      await paceRequest();
      const fetched = await fetchSupermixProduct(id, config);
      if (!fetched.ok) {
        requestFailures.push(fetched.reason);
        for (const row of linkedRows) {
          results.set(row, error(SUPERMIX_SHOP_ID, fetched.reason, true, false));
        }
        continue;
      }
      product = fetched.product;
    }

    for (const row of linkedRows) {
      results.set(row, toSupermixPriceResult(product, parseSupermixReference(row.api)!.variantId));
    }
  }

  const missing: ShopPriceRow[] = [];
  for (const [row, { id, slug }] of references) {
    // Once a row has a product id, a slug match could be a different product.
    const product = id ? productsById.get(id) : productsBySlug.get(slug!);
    if (product) {
      results.set(row, toSupermixPriceResult(product));
      const productId = productIdOf(product);
      if (productId && productId !== row.api) {
        if (!dryRun) {
          await persistProductId(row, productId);
        }
        row.api = productId;
      }
    } else {
      missing.push(row);
    }
  }

  // Products that left the listing (or moved between pages mid-run) are looked
  // up one by one, so a visible price is hidden only when Supermix says the
  // product is gone. Rows already hidden stay hidden without a request.
  let lookups = 0;
  for (const row of missing) {
    if (catalogComplete && row.hidden) {
      results.set(row, toSupermixPriceResult(null));
      continue;
    }

    if (lookups >= maxLookups) {
      results.set(row, error(SUPERMIX_SHOP_ID, "lookup_limit_reached", true, false));
      continue;
    }

    const { id, slug } = references.get(row)!;
    lookups += 1;
    await paceRequest();
    const fetched = await fetchSupermixProduct((id ?? slug)!, config);
    if (!fetched.ok) {
      requestFailures.push(fetched.reason);
      results.set(row, error(SUPERMIX_SHOP_ID, fetched.reason, true, false));
      continue;
    }

    results.set(row, toSupermixPriceResult(fetched.product));
    const productId = productIdOf(fetched.product);
    if (productId && productId !== row.api) {
      if (!dryRun) {
        await persistProductId(row, productId);
      }
      row.api = productId;
    }
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
            ? ` currentPrice=${result.currentPrice} regularPrice=${result.regularPrice ?? "-"} previous=${row.currentPrice ?? "-"}/${row.regularPrice ?? "-"}`
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
    "### Supermix price sync",
    "",
    `- Rows: ${rows.length}`,
    `- Requests: ${requestCount} (${catalogPages} catalog pages, ${productsById.size} catalog products, ${variantLookups} variant products, ${lookups} lookups)`,
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
      `Supermix sync needs attention: requestFailures=${requestFailures.length} errors=${errorCount} stale=${staleRows.length}`
    );
  }
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[ERROR] supermix price sync failed", err);
    await closeDb();
    process.exit(1);
  });
