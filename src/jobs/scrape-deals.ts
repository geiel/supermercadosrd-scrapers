#!/usr/bin/env node

import { eq, sql } from "drizzle-orm";
import { applyScrapeResult, type ShopPriceRow } from "../db/apply-scrape-result.js";
import { closeDb, db } from "../db/client.js";
import { productsShopsPrices, todaysDeals } from "../db/schema.js";
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

  const delayMinMs = parseNumberArg(args, "--delay-min", 600);
  const delayMaxMs = parseNumberArg(args, "--delay-max", 1200);
  const timeoutMs = parseNumberArg(args, "--timeout", 10000);
  const maxRetries = parseNumberArg(args, "--retries", 3);

  const shopPrices = await db
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
    .from(todaysDeals)
    .innerJoin(productsShopsPrices, eq(todaysDeals.productId, productsShopsPrices.productId));

  const perShopPrices = shopIds.map((shopId) =>
    (shopPrices as ShopPriceRow[]).filter((shopPrice) => shopPrice.shopId === shopId)
  );
  const totalUrls = perShopPrices.reduce((sum, prices) => sum + prices.length, 0);

  console.log(`[INFO] ${totalUrls} URLs found across ${shopIds.length} shops`);

  const totalRounds = Math.max(0, ...perShopPrices.map((prices) => prices.length));

  console.time("deals-shop-prices");
  for (let round = 0; round < totalRounds; round += 1) {
    const roundPrices = perShopPrices
      .map((prices) => prices[round])
      .filter((price): price is ShopPriceRow => Boolean(price));

    if (roundPrices.length === 0) {
      break;
    }

    console.log(
      `[INFO] Round ${round + 1}/${totalRounds} - Processing ${roundPrices.length} URLs`
    );

    await Promise.all(
      roundPrices.map((shopPrice) => processShopPrice(shopPrice, timeoutMs, maxRetries))
    );

    if (round < totalRounds - 1 && roundPrices.length > 0) {
      await randomDelay(delayMinMs, delayMaxMs);
    }
  }
  console.timeEnd("deals-shop-prices");

  console.log("[INFO] Start running refresh deals function");
  await db.execute(sql`SELECT public.refresh_todays_deals()`);
  console.log("[INFO] refresh deals completed");
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[ERROR] deals scrape failed", err);
    await closeDb();
    process.exit(1);
  });
