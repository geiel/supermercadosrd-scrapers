#!/usr/bin/env node

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { applyScrapeResult, type ShopPriceRow } from "../db/apply-scrape-result.js";
import { db } from "../db/client.js";
import { products, productsShopsPrices } from "../db/schema.js";
import { scrapePrice } from "../scrape-price.js";
import type { ShopId } from "../types.js";
import { randomDelay } from "../utils.js";

const shopIds = [1, 2, 3, 4, 5, 6] as const;

function isShopId(value: number): value is ShopId {
  return value >= 1 && value <= 6;
}

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

async function processShopPrice(
  shopPrice: ShopPriceRow,
  timeoutMs: number,
  maxRetries: number
) {
  if (!isShopId(shopPrice.shopId)) {
    console.error(`[WARN] unsupported shopId=${shopPrice.shopId}`);
    return;
  }

  const result = await scrapePrice(
    {
      shopId: shopPrice.shopId,
      url: shopPrice.url,
      api: shopPrice.api,
    },
    {
      timeoutMs,
      maxRetries,
    }
  );

  if (
    result.status === "error" &&
    result.shopId === 2 &&
    result.reason === "backend_503"
  ) {
    throw new Error("Nacional returned backend_503");
  }

  await applyScrapeResult(shopPrice, result);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const iterationCount = parseNumberArg(args, "--iterations", 80);
  const urlsPerShop = parseNumberArg(args, "--urls-per-shop", 5);
  const delayMinMs = parseNumberArg(args, "--delay-min", 600);
  const delayMaxMs = parseNumberArg(args, "--delay-max", 1200);
  const timeoutMs = parseNumberArg(args, "--timeout", 10000);
  const maxRetries = parseNumberArg(args, "--retries", 3);

  const shopPricesFilter = and(
    or(isNull(products.deleted), eq(products.deleted, false)),
    or(
      and(
        or(
          isNull(productsShopsPrices.updateAt),
          sql`${productsShopsPrices.updateAt} < now() - INTERVAL '12 HOURS'`
        ),
        or(
          isNull(productsShopsPrices.hidden),
          eq(productsShopsPrices.hidden, false)
        )
      ),
      and(
        eq(productsShopsPrices.hidden, true),
        sql`${productsShopsPrices.updateAt} < now() - INTERVAL '3 DAYS'`
      )
    )
  );

  console.time("batch-shop-prices");
  for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
    const iterationStart = Date.now();

    const perShopPrices = await Promise.all(
      shopIds.map(async (shopId) => {
        const rows = await db
          .select({
            productId: productsShopsPrices.productId,
            shopId: productsShopsPrices.shopId,
            url: productsShopsPrices.url,
            api: productsShopsPrices.api,
            currentPrice: productsShopsPrices.currentPrice,
            regularPrice: productsShopsPrices.regularPrice,
            updateAt: productsShopsPrices.updateAt,
            hidden: productsShopsPrices.hidden,
          })
          .from(productsShopsPrices)
          .innerJoin(products, eq(productsShopsPrices.productId, products.id))
          .where(and(eq(productsShopsPrices.shopId, shopId), shopPricesFilter))
          .orderBy(productsShopsPrices.updateAt)
          .limit(urlsPerShop);

        return rows as ShopPriceRow[];
      })
    );

    const totalUrls = perShopPrices.reduce((sum, prices) => sum + prices.length, 0);
    console.log(
      `[INFO] Iteration ${iteration}/${iterationCount} - ${totalUrls} URLs found across ${shopIds.length} shops`
    );

    for (let round = 0; round < urlsPerShop; round += 1) {
      const roundPrices = perShopPrices
        .map((shopPrices) => shopPrices[round])
        .filter((price): price is ShopPriceRow => Boolean(price));

      if (roundPrices.length === 0) {
        break;
      }

      console.log(
        `[INFO] Iteration ${iteration} - Round ${round + 1}/${urlsPerShop} - Processing ${roundPrices.length} URLs`
      );

      await Promise.all(
        roundPrices.map((shopPrice) => processShopPrice(shopPrice, timeoutMs, maxRetries))
      );

      if (round < urlsPerShop - 1 && roundPrices.length > 0) {
        await randomDelay(delayMinMs, delayMaxMs);
      }
    }

    await randomDelay(delayMinMs, delayMaxMs);

    const iterationTime = Date.now() - iterationStart;
    console.log(
      `[INFO] Iteration ${iteration}/${iterationCount} completed in ${iterationTime}ms`
    );
  }
  console.timeEnd("batch-shop-prices");
}

void main().catch((err) => {
  console.error("[ERROR] prices batch failed", err);
  process.exit(1);
});
