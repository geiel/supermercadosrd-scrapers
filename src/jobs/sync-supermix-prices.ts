#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { applyScrapeResult, type ShopPriceRow } from "../db/apply-scrape-result.js";
import { closeDb, db } from "../db/client.js";
import { products, productsShopsPrices } from "../db/schema.js";
import { error, notFound } from "../result.js";
import {
  SUPERMIX_HANDLES_BATCH_SIZE,
  SUPERMIX_NODES_BATCH_SIZE,
  SUPERMIX_SHOP_ID,
  fetchSupermixNodes,
  getSupermixStorefrontConfig,
  parseSupermixGid,
  parseSupermixHandle,
  resolveSupermixHandles,
  toSupermixPriceResult,
} from "../shops/supermix.js";
import type { ScrapePriceResult } from "../types.js";
import { mapWithConcurrency, randomDelay } from "../utils.js";

// Refreshes every Supermix price (visible and hidden) in a few batched
// Storefront API requests. It runs on its own schedule and never touches the
// shared prices batch, so other shops are unaffected.

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

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
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

async function persistProductGid(row: ShopPriceRow, gid: string) {
  await db
    .update(productsShopsPrices)
    .set({ api: gid })
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        eq(productsShopsPrices.shopId, SUPERMIX_SHOP_ID),
        sql`${productsShopsPrices.api} IS DISTINCT FROM ${gid}`
      )
    );
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
  const delayMinMs = parseNumberArg(args, "--delay-min", 3000);
  const delayMaxMs = parseNumberArg(args, "--delay-max", 5000);
  const maxAgeHours = parseNumberArg(args, "--max-age-hours", 12);
  const concurrency = parseNumberArg(args, "--concurrency", 4);
  const targetProductId = parseOptionalIntegerArg(args, "--product-id");
  const limit = parseOptionalIntegerArg(args, "--limit");
  const partialRun = targetProductId !== null || limit !== null;

  const config = getSupermixStorefrontConfig();
  const rows = await loadSupermixRows(targetProductId, limit);
  console.log(
    `[INFO] supermix rows=${rows.length}${dryRun ? " (dry run: no database writes)" : ""}`
  );

  const results = new Map<ShopPriceRow, ScrapePriceResult>();
  const requestFailures: string[] = [];
  let requestCount = 0;
  const apiVersions = new Set<string>();

  async function paceRequest() {
    if (requestCount > 0) {
      await randomDelay(delayMinMs, delayMaxMs);
    }

    requestCount += 1;
  }

  const rowsByGid = new Map<string, ShopPriceRow[]>();
  const rowsByHandle = new Map<string, ShopPriceRow[]>();
  const addTo = (map: Map<string, ShopPriceRow[]>, key: string, row: ShopPriceRow) =>
    map.set(key, [...(map.get(key) ?? []), row]);

  for (const row of rows) {
    const gid = parseSupermixGid(row.api)?.gid;
    const handle = gid ? null : parseSupermixHandle(row.url);

    if (gid) {
      addTo(rowsByGid, gid, row);
    } else if (handle) {
      addTo(rowsByHandle, handle, row);
    } else {
      results.set(row, error(SUPERMIX_SHOP_ID, "missing_product_reference", false, false));
    }
  }

  // Rows added with only a product URL: resolve the handle once and keep the GID.
  for (const handles of chunk([...rowsByHandle.keys()], SUPERMIX_HANDLES_BATCH_SIZE)) {
    await paceRequest();
    const resolved = await resolveSupermixHandles(handles, config);

    for (const handle of handles) {
      for (const row of rowsByHandle.get(handle) ?? []) {
        if (!resolved.ok) {
          results.set(row, error(SUPERMIX_SHOP_ID, resolved.reason, true, false));
          continue;
        }

        const gid = resolved.gidByHandle.get(handle);
        if (!gid) {
          results.set(row, notFound(SUPERMIX_SHOP_ID, "product_not_found", true));
          continue;
        }

        if (!dryRun) {
          await persistProductGid(row, gid);
        }
        row.api = gid;
        addTo(rowsByGid, gid, row);
      }
    }

    if (!resolved.ok) {
      requestFailures.push(resolved.reason);
    }
  }

  for (const gids of chunk([...rowsByGid.keys()], SUPERMIX_NODES_BATCH_SIZE)) {
    await paceRequest();
    const fetched = await fetchSupermixNodes(gids, config);

    if (!fetched.ok) {
      requestFailures.push(fetched.reason);
    } else if (fetched.apiVersion) {
      apiVersions.add(fetched.apiVersion);
    }

    for (const gid of gids) {
      for (const row of rowsByGid.get(gid) ?? []) {
        results.set(
          row,
          fetched.ok
            ? toSupermixPriceResult(fetched.nodesByGid.get(gid))
            : error(SUPERMIX_SHOP_ID, fetched.reason, true, false)
        );
      }
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
    await mapWithConcurrency([...results.entries()], concurrency, ([row, result]) =>
      applyScrapeResult(row, result)
    );
  }

  const errorCount = [...results.values()].filter((result) => result.status === "error").length;
  const staleRows = dryRun || partialRun ? [] : await findStaleVisibleRows(maxAgeHours);

  const summary = [
    "### Supermix price sync",
    "",
    `- Rows: ${rows.length}`,
    `- Storefront requests: ${requestCount}${apiVersions.size ? ` (API ${[...apiVersions].join(", ")})` : ""}`,
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
