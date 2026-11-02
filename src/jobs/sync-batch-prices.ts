#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  BATCH_PRICE_SHOP_IDS,
  batchLookupKeys,
  batchPriceRowCondition,
  chunkBatchRows,
  matchSirenaProducts,
  matchSkuItems,
  splitBatchChunk,
  type BatchChunk,
  type BatchPriceShopId,
} from "../batch-price-sync.js";
import { applyScrapeResult, type ShopPriceRow } from "../db/apply-scrape-result.js";
import type { PurchaseTerms } from "../purchase-terms.js";
import { closeDb, db } from "../db/client.js";
import { products, productsShopsPrices } from "../db/schema.js";
import { error, SHOP_NAMES } from "../result.js";
import { scrapePrice } from "../scrape-price.js";
import { fetchJumboProductsBySkus, toJumboPriceResult } from "../shops/jumbo.js";
import { fetchMercaJumboProductsBySkus } from "../shops/merca-jumbo-shared.js";
import { toMercaJumboPriceResult } from "../shops/merca-jumbo.js";
import {
  fetchNacionalGraphqlPricesBySkus,
  toNacionalGraphqlPriceResult,
} from "../shops/nacional.js";
import { toSirenaVtexPriceResult } from "../shops/sirena.js";
import {
  fetchSirenaVtexProductsByFilter,
  SIRENA_VTEX_MAX_SEARCH_RESULTS,
  type SirenaVtexFilterField,
} from "../sirena-vtex.js";
import type { FetchWithRetryConfig, ScrapePriceResult } from "../types.js";
import { mapWithConcurrency, randomDelay } from "../utils.js";

// Refreshes every Sirena (VTEX), Nacional, Jumbo and Merca Jumbo price with
// batched lookups: one request prices up to 50 products (~1,000 requests for
// ~50k rows, where the per-product batch spent one request per row). Products
// a batch leaves out are looked up one by one with the single scrapers, so a
// visible price is only hidden on the same evidence as before. Hidden rows are
// rechecked once a day. It runs on its own schedule; the per-product batch and
// the deals job skip these rows.

// Each backend gets one request at a time. Nacional, Merca Jumbo and Jumbo are
// the same Magento servers, so they share a queue; Sirena has its own.
const HOST_GROUPS: BatchPriceShopId[][] = [[1], [2, 7, 3]];

// Statuses that mean the backend is pushing back: stop asking it this run.
const BACKOFF_REASONS = new Set(["http_403", "http_429", "http_503"]);
const MAX_CONSECUTIVE_FAILURES = 3;

const HIDDEN_RECHECK_HOURS = 24;

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
const priceIsVisible = or(
  isNull(productsShopsPrices.hidden),
  eq(productsShopsPrices.hidden, false)
);

async function loadShopRows(
  shopId: BatchPriceShopId,
  productId: number | null,
  limit: number | null
) {
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
      presentation: sql<string>`product_measurement_label(${products.id})`,
    })
    .from(productsShopsPrices)
    .innerJoin(products, eq(productsShopsPrices.productId, products.id))
    .where(
      and(
        eq(productsShopsPrices.shopId, shopId),
        productIsActive,
        batchPriceRowCondition,
        productId === null
          ? or(
              priceIsVisible,
              isNull(productsShopsPrices.updateAt),
              sql`${productsShopsPrices.updateAt} < now() - (${HIDDEN_RECHECK_HOURS}::float8 * interval '1 hour')`
            )
          : eq(productsShopsPrices.productId, productId)
      )
    )
    .orderBy(sql`${productsShopsPrices.updateAt} asc nulls first`, asc(productsShopsPrices.productId));

  return (limit === null ? await query : await query.limit(limit)) as ShopPriceRow[];
}

async function findStaleVisibleRows(maxAgeHours: number) {
  return db
    .select({
      productId: productsShopsPrices.productId,
      shopId: productsShopsPrices.shopId,
      url: productsShopsPrices.url,
      updateAt: productsShopsPrices.updateAt,
    })
    .from(productsShopsPrices)
    .innerJoin(products, eq(productsShopsPrices.productId, products.id))
    .where(
      and(
        inArray(productsShopsPrices.shopId, [...BATCH_PRICE_SHOP_IDS]),
        productIsActive,
        batchPriceRowCondition,
        priceIsVisible,
        or(
          isNull(productsShopsPrices.updateAt),
          sql`${productsShopsPrices.updateAt} < now() - (${maxAgeHours}::float8 * interval '1 hour')`
        )
      )
    )
    .orderBy(sql`${productsShopsPrices.updateAt} asc nulls first`);
}

// Rows that stay hidden only get their check time moved, without a page
// revalidation, so they wait another day before the next check.
async function touchHiddenRows(shopId: BatchPriceShopId, rows: ShopPriceRow[]) {
  const productIds = rows.map((row) => row.productId);
  for (let index = 0; index < productIds.length; index += 500) {
    await db
      .update(productsShopsPrices)
      .set({ updateAt: new Date() })
      .where(
        and(
          eq(productsShopsPrices.shopId, shopId),
          inArray(productsShopsPrices.productId, productIds.slice(index, index + 500)),
          eq(productsShopsPrices.hidden, true)
        )
      );
  }
}

type ChunkOutcome =
  | { ok: true; results: Map<ShopPriceRow, ScrapePriceResult> }
  | { ok: false; reason: string };

function mapResults<T>(
  matches: Map<ShopPriceRow, T>,
  toResult: (item: T, row: ShopPriceRow) => ScrapePriceResult
) {
  return new Map(
    [...matches].map(([row, item]) => [row, toResult(item, row)] as const)
  );
}

async function priceChunk(
  shopId: BatchPriceShopId,
  chunk: BatchChunk,
  requestConfig: FetchWithRetryConfig
): Promise<ChunkOutcome> {
  switch (shopId) {
    case 1: {
      const lookup = await fetchSirenaVtexProductsByFilter(
        chunk.group as SirenaVtexFilterField,
        chunk.keys,
        requestConfig
      );
      if (!lookup.ok) {
        return lookup;
      }

      return {
        ok: true,
        results: mapResults(
          matchSirenaProducts(chunk.rows, lookup.products),
          toSirenaVtexPriceResult
        ),
      };
    }
    case 2: {
      const lookup = await fetchNacionalGraphqlPricesBySkus(chunk.keys, requestConfig);
      if (!lookup.ok) {
        return lookup;
      }

      return {
        ok: true,
        results: mapResults(matchSkuItems(chunk.rows, lookup.items), (item) =>
          toNacionalGraphqlPriceResult(item)
        ),
      };
    }
    case 3: {
      const lookup = await fetchJumboProductsBySkus(chunk.keys, requestConfig);
      if (!lookup.ok) {
        return lookup;
      }

      return {
        ok: true,
        results: mapResults(
          matchSkuItems(chunk.rows, lookup.items),
          toJumboPriceResult
        ),
      };
    }
    case 7: {
      const lookup = await fetchMercaJumboProductsBySkus(
        { skus: chunk.keys, api: chunk.rows[0].api },
        requestConfig
      );
      if (!lookup.ok) {
        return lookup;
      }

      return {
        ok: true,
        results: mapResults(
          matchSkuItems(chunk.rows, lookup.items),
          toMercaJumboPriceResult
        ),
      };
    }
  }
}

function toScrapeInput(shopId: BatchPriceShopId, row: ShopPriceRow) {
  return {
    shopId,
    url: row.url,
    api: row.api,
    locationId: row.locationId,
    presentation: row.presentation,
    purchaseMode: row.purchaseMode,
    purchaseUnit: row.purchaseUnit,
  };
}

function describeResult(result: ScrapePriceResult) {
  return result.status === "ok" ? "ok" : `${result.status}:${result.reason}`;
}

function describeTerms(terms: PurchaseTerms | null | undefined) {
  if (terms === undefined) {
    return "keep";
  }

  return terms === null
    ? null
    : `${terms.mode}:${terms.unit}:${Number(terms.minimum)}:${Number(terms.increment)}:${terms.source}`;
}

function priceChanged(row: ShopPriceRow, result: ScrapePriceResult) {
  return (
    result.status === "ok" &&
    (Number(row.currentPrice) !== Number(result.currentPrice) ||
      Number(row.regularPrice ?? 0) !== Number(result.regularPrice ?? 0))
  );
}

function writeReportLine(path: string | null, line: Record<string, unknown>) {
  if (path) {
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  }
}

function writeStepSummary(lines: string[]) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${lines.join("\n")}\n`);
  }
}

type ShopReport = {
  shopId: BatchPriceShopId;
  rows: number;
  batchRequests: number;
  batchFound: number;
  lookups: number;
  hiddenUnchanged: number;
  priceChanges: number;
  minutes: number;
  outcomes: Map<string, number>;
  // Systemic problems: a stopped backend, skipped rows, the lookup limit.
  failures: string[];
  // One product the store cannot serve (isolated by splitting) or a failed
  // single lookup. A few are reported; many fail the run.
  rowFailures: string[];
};

type RunOptions = {
  dryRun: boolean;
  batchSize: number;
  maxLookups: number;
  concurrency: number;
  delayMinMs: number;
  delayMaxMs: number;
  requestConfig: FetchWithRetryConfig;
  productId: number | null;
  limit: number | null;
  // One JSON line per priced row, appended as the run goes.
  reportPath: string | null;
};

async function syncHostGroup(shopIds: BatchPriceShopId[], options: RunOptions) {
  const reports: ShopReport[] = [];
  let requestCount = 0;
  let consecutiveFailures = 0;
  let stoppedReason: string | null = null;

  async function paceRequest() {
    if (requestCount > 0) {
      await randomDelay(options.delayMinMs, options.delayMaxMs);
    }

    requestCount += 1;
  }

  // Requests that split a failed batch do not count toward the consecutive
  // failures: one broken product fails every half that holds it.
  function recordRequest(reason: string | null, countsTowardStop = true) {
    if (reason === null) {
      if (countsTowardStop) {
        consecutiveFailures = 0;
      }
      return;
    }

    if (BACKOFF_REASONS.has(reason)) {
      stoppedReason = reason;
      return;
    }

    if (countsTowardStop) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stoppedReason = `${consecutiveFailures}_consecutive_failures:${reason}`;
      }
    }
  }

  // Writes one chunk while the next request is on its way. A failed write is
  // kept and rethrown at the end instead of crashing the run midway.
  let pendingWrites: Promise<void> = Promise.resolve();
  const writeErrors: unknown[] = [];
  const queueWrite = (task: () => Promise<unknown>) => {
    pendingWrites = pendingWrites
      .then(async () => {
        await task();
      })
      .catch((writeError) => {
        writeErrors.push(writeError);
      });
  };

  for (const shopId of shopIds) {
    const shopName = SHOP_NAMES[shopId];
    const shopStartedAt = Date.now();
    const rows = await loadShopRows(shopId, options.productId, options.limit);
    const report: ShopReport = {
      shopId,
      rows: rows.length,
      batchRequests: 0,
      batchFound: 0,
      lookups: 0,
      hiddenUnchanged: 0,
      priceChanges: 0,
      minutes: 0,
      outcomes: new Map(),
      failures: [],
      rowFailures: [],
    };
    reports.push(report);
    console.log(`[INFO] ${shopName} rows=${rows.length}`);

    const stillHidden: ShopPriceRow[] = [];

    const settle = (row: ShopPriceRow, result: ScrapePriceResult, source: string) => {
      const outcome = describeResult(result);
      report.outcomes.set(outcome, (report.outcomes.get(outcome) ?? 0) + 1);
      if (priceChanged(row, result)) {
        report.priceChanges += 1;
      }

      writeReportLine(options.reportPath, {
        shopId,
        productId: row.productId,
        hidden: Boolean(row.hidden),
        source,
        previous: [row.currentPrice, row.regularPrice],
        outcome,
        ...(result.status === "ok"
          ? {
              price: [result.currentPrice, result.regularPrice],
              terms: describeTerms(result.purchaseTerms),
            }
          : {}),
        previousTerms: row.purchaseTermsSource
          ? `${row.purchaseMode}:${row.purchaseUnit}:${Number(row.minimumPurchaseQuantity)}:${Number(row.purchaseQuantityIncrement)}:${row.purchaseTermsSource}`
          : null,
      });

      // An already hidden price that is still unavailable needs no write.
      if (row.hidden && result.status !== "ok") {
        stillHidden.push(row);
        return null;
      }

      return [row, result] as const;
    };

    const writeResults = (writes: Array<readonly [ShopPriceRow, ScrapePriceResult]>) => {
      if (options.dryRun || writes.length === 0) {
        return;
      }

      queueWrite(() =>
        mapWithConcurrency(writes, options.concurrency, ([row, result]) =>
          applyScrapeResult(row, result)
        )
      );
    };

    const batchable: Array<{ row: ShopPriceRow; lookup: NonNullable<ReturnType<typeof batchLookupKeys>> }> = [];
    const unbatchable: ShopPriceRow[] = [];
    const missing: ShopPriceRow[] = [];
    for (const row of rows) {
      const lookup = batchLookupKeys(row);
      if (lookup) {
        batchable.push({ row, lookup });
      } else if (shopId === 1) {
        // The row condition already leaves these out; if one slips through,
        // it gets a paced single lookup.
        missing.push(row);
      } else {
        unbatchable.push(row);
      }
    }

    // A Nacional, Jumbo or Merca Jumbo row without a SKU in its URL cannot be
    // priced at all: the single scraper reports the same error it does today
    // without sending a request, so it needs no pacing.
    const writesWithoutRequests = [];
    for (const row of unbatchable) {
      const write = settle(row, await scrapePrice(toScrapeInput(shopId, row)), "no_request");
      if (write) {
        writesWithoutRequests.push(write);
      }
    }
    writeResults(writesWithoutRequests);

    const maxKeys = Math.min(
      options.batchSize,
      shopId === 1 ? SIRENA_VTEX_MAX_SEARCH_RESULTS : options.batchSize
    );

    // A request that fails for any reason but backoff is split in two and
    // each half is asked again, down to single rows. A product that breaks
    // the store's query (Magento "Internal server error", VTEX HTTP 500) then
    // fails only its own row; a passing error is simply retried in halves.
    const queue = chunkBatchRows(batchable, maxKeys).map((chunk) => ({
      chunk,
      split: false,
    }));
    while (queue.length > 0) {
      const { chunk, split } = queue.shift()!;
      if (stoppedReason) {
        report.failures.push(`skipped_${chunk.rows.length}_rows`);
        continue;
      }

      await paceRequest();
      report.batchRequests += 1;
      const outcome = await priceChunk(shopId, chunk, options.requestConfig);
      recordRequest(outcome.ok ? null : outcome.reason, !split);

      if (!outcome.ok) {
        console.error(
          `[ERROR] ${shopName} batch of ${chunk.rows.length} rows failed${split ? " (split)" : ""} reason=${outcome.reason} ${chunk.group}=${chunk.keys.join(",")}`
        );
        if (BACKOFF_REASONS.has(outcome.reason)) {
          report.failures.push(outcome.reason);
          continue;
        }

        const halves = splitBatchChunk(chunk);
        if (halves) {
          queue.unshift(...halves.map((half) => ({ chunk: half, split: true })));
          continue;
        }

        // One row the store cannot price: keep its stored price.
        for (const row of chunk.rows) {
          report.rowFailures.push(`${row.productId}:${outcome.reason}`);
          settle(row, error(shopId, outcome.reason, true, false), "batch");
        }
        continue;
      }

      const writes = [];
      for (const row of chunk.rows) {
        const result = outcome.results.get(row);
        if (!result) {
          // Left out of a good response: visible rows get the single
          // lookup; hidden ones stay hidden until they show up again.
          if (row.hidden) {
            stillHidden.push(row);
          } else {
            missing.push(row);
          }
          continue;
        }

        report.batchFound += 1;
        const write = settle(row, result, "batch");
        if (write) {
          writes.push(write);
        }
      }
      writeResults(writes);
    }

    // Single lookups, capped so a broken batch cannot turn into thousands of
    // requests.
    for (const row of missing) {
      if (stoppedReason) {
        report.failures.push("skipped_lookup");
        continue;
      }

      if (report.lookups >= options.maxLookups) {
        report.failures.push("lookup_limit_reached");
        settle(row, error(shopId, "lookup_limit_reached", true, false), "lookup");
        continue;
      }

      await paceRequest();
      report.lookups += 1;
      const result = await scrapePrice(toScrapeInput(shopId, row), options.requestConfig);
      const failed = result.status === "error" && result.retryable;
      recordRequest(failed ? result.reason : null);
      if (failed) {
        report.rowFailures.push(`${row.productId}:lookup:${result.reason}`);
      }

      const write = settle(row, result, "lookup");
      if (write) {
        writeResults([write]);
      }
    }

    report.hiddenUnchanged = stillHidden.length;
    report.minutes = (Date.now() - shopStartedAt) / 60000;
    console.log(
      `[INFO] ${shopName} done in ${report.minutes.toFixed(1)} min: ${report.batchRequests} batch requests, ${report.lookups} single lookups`
    );
    if (!options.dryRun && stillHidden.length > 0) {
      queueWrite(() => touchHiddenRows(shopId, stillHidden));
    }
  }

  await pendingWrites;
  if (writeErrors.length > 0) {
    throw writeErrors[0];
  }

  return { reports, requestCount, stoppedReason };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.get("--dry-run") === "true";
  const targetShopId = parseOptionalIntegerArg(args, "--shop-id");
  if (
    targetShopId !== null &&
    !(BATCH_PRICE_SHOP_IDS as readonly number[]).includes(targetShopId)
  ) {
    throw new Error(`Unsupported shop id: ${targetShopId}`);
  }

  const reportPath = args.get("--report") ?? null;
  const options: RunOptions = {
    dryRun,
    batchSize: parseNumberArg(args, "--batch-size", 50),
    maxLookups: parseNumberArg(args, "--max-lookups", 300),
    concurrency: parseNumberArg(args, "--concurrency", 2),
    delayMinMs: parseNumberArg(args, "--delay-min", 1000),
    delayMaxMs: parseNumberArg(args, "--delay-max", 1500),
    requestConfig: {
      timeoutMs: parseNumberArg(args, "--timeout", 20000),
      maxRetries: parseNumberArg(args, "--retries", 3),
    },
    productId: parseOptionalIntegerArg(args, "--product-id"),
    limit: parseOptionalIntegerArg(args, "--limit"),
    reportPath,
  };
  if (reportPath) {
    writeFileSync(reportPath, "");
  }
  const maxAgeHours = parseNumberArg(args, "--max-age-hours", 6);
  // A handful of products the stores cannot serve is reported without failing
  // the run; more than this many means something broader is wrong.
  const maxRowFailures = parseNumberArg(args, "--max-row-failures", 25);
  const maxStaleRows = parseNumberArg(args, "--max-stale", 25);
  const partialRun =
    targetShopId !== null || options.productId !== null || options.limit !== null;

  const hostGroups = HOST_GROUPS.map((group) =>
    group.filter((shopId) => targetShopId === null || shopId === targetShopId)
  ).filter((group) => group.length > 0);

  console.log(
    `[INFO] batch price sync shops=${hostGroups.flat().join(",")} batchSize=${options.batchSize}${dryRun ? " (dry run: no database writes)" : ""}`
  );
  const startedAt = Date.now();
  const groups = await Promise.all(
    hostGroups.map((group) => syncHostGroup(group, options))
  );
  const elapsedMinutes = ((Date.now() - startedAt) / 60000).toFixed(1);

  const staleRows = dryRun || partialRun ? [] : await findStaleVisibleRows(maxAgeHours);
  const reports = groups.flatMap((group) => group.reports);
  const failures = reports.flatMap((report) =>
    report.failures.map((failure) => `${SHOP_NAMES[report.shopId]}:${failure}`)
  );
  const stopped = groups.flatMap((group) => (group.stoppedReason ? [group.stoppedReason] : []));
  const rowFailures = reports.flatMap((report) =>
    report.rowFailures.map((failure) => `${SHOP_NAMES[report.shopId]}:${failure}`)
  );

  const summary = [
    "### Batch price sync",
    "",
    `- Requests: ${groups.reduce((sum, group) => sum + group.requestCount, 0)} in ${elapsedMinutes} min${dryRun ? " (dry run)" : ""}`,
    ...reports.map((report) => {
      const outcomes = [...report.outcomes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([outcome, count]) => `${outcome} ${count}`)
        .join(", ");
      return `- ${SHOP_NAMES[report.shopId]} (${report.minutes.toFixed(1)} min): ${report.rows} rows, ${report.batchRequests} batch requests (${report.batchFound} found), ${report.lookups} single lookups, ${report.hiddenUnchanged} still hidden, ${report.priceChanges} price changes; ${outcomes}`;
    }),
    `- Stopped early: ${stopped.length ? stopped.join(", ") : "no"}`,
    `- Failures: ${failures.length}${failures.length ? ` (${[...new Set(failures)].slice(0, 10).join(", ")})` : ""}`,
    `- Products the store could not price: ${rowFailures.length}${rowFailures.length ? ` (${rowFailures.slice(0, 10).join(", ")})` : ""} (the run fails above ${maxRowFailures})`,
    `- Visible prices older than ${maxAgeHours}h: ${dryRun || partialRun ? "not checked" : staleRows.length} (the run fails above ${maxStaleRows})`,
  ];
  console.log(summary.join("\n"));
  writeStepSummary(summary);

  for (const row of staleRows.slice(0, 20)) {
    console.error(
      `[STALE] shopId=${row.shopId} productId=${row.productId} updateAt=${row.updateAt?.toISOString() ?? "never"} url=${row.url}`
    );
  }

  if (
    failures.length > 0 ||
    rowFailures.length > maxRowFailures ||
    staleRows.length > maxStaleRows
  ) {
    throw new Error(
      `Batch price sync needs attention: failures=${failures.length} rowFailures=${rowFailures.length} stale=${staleRows.length}`
    );
  }
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[ERROR] batch price sync failed", err);
    await closeDb();
    process.exit(1);
  });
