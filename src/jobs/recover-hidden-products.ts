#!/usr/bin/env node

import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import { closeDb, db } from "../db/client.js";
import { ensureRecoverySchema } from "../db/ensure-recovery-schema.js";
import {
  productShopRecoveryReviews,
  products,
  productsShopsPrices,
} from "../db/schema.js";
import { recoverHiddenProduct } from "../recovery/lookup.js";
import { deriveRecoveryKeyFromRow, RECOVERABLE_SHOP_IDS } from "../recovery/shared.js";
import { upsertRecoveryKey, upsertRecoveryReview } from "../recovery/store.js";
import {
  isRecoverableShopId,
  type HiddenProductRecoveryRow,
  type RecoverableShopId,
} from "../recovery/types.js";
import { randomDelay } from "../utils.js";

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

function parseRecoverableShopIdsArg(
  args: Map<string, string>,
  key: string
): RecoverableShopId[] | null {
  const raw = args.get(key);
  if (!raw) {
    return null;
  }

  const uniqueShopIds = new Set<RecoverableShopId>();

  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Invalid recoverable shop id for ${key}: ${trimmed}`);
    }

    const parsedShopId = parsed as Parameters<typeof isRecoverableShopId>[0];
    if (!isRecoverableShopId(parsedShopId)) {
      throw new Error(`Invalid recoverable shop id for ${key}: ${trimmed}`);
    }

    uniqueShopIds.add(parsedShopId);
  }

  const selectedShopIds = Array.from(uniqueShopIds);
  if (selectedShopIds.length === 0) {
    throw new Error(`No valid shop ids provided for ${key}`);
  }

  return selectedShopIds;
}

async function getHiddenProductsForShop(
  shopId: RecoverableShopId,
  limit: number
): Promise<HiddenProductRecoveryRow[]> {
  const rows = await db
    .select({
      productId: productsShopsPrices.productId,
      productName: products.name,
      shopId: productsShopsPrices.shopId,
      url: productsShopsPrices.url,
      api: productsShopsPrices.api,
      locationId: productsShopsPrices.locationId,
      currentPrice: productsShopsPrices.currentPrice,
      regularPrice: productsShopsPrices.regularPrice,
      updateAt: productsShopsPrices.updateAt,
      hidden: productsShopsPrices.hidden,
      recoveryReviewProductId: productShopRecoveryReviews.productId,
      proposalStatus: productShopRecoveryReviews.proposalStatus,
      verificationStatus: productShopRecoveryReviews.verificationStatus,
    })
    .from(productsShopsPrices)
    .innerJoin(products, eq(productsShopsPrices.productId, products.id))
    .leftJoin(
      productShopRecoveryReviews,
      and(
        eq(productShopRecoveryReviews.productId, productsShopsPrices.productId),
        eq(productShopRecoveryReviews.shopId, productsShopsPrices.shopId)
      )
    )
    .where(
      and(
        eq(productsShopsPrices.shopId, shopId),
        eq(productsShopsPrices.hidden, true),
        or(isNull(products.deleted), eq(products.deleted, false)),
        or(
          isNull(productShopRecoveryReviews.productId),
          isNull(productShopRecoveryReviews.proposalStatus),
          ne(productShopRecoveryReviews.proposalStatus, "pending_review"),
          ne(productShopRecoveryReviews.verificationStatus, "verified")
        )
      )
    )
    .orderBy(asc(productsShopsPrices.updateAt), asc(productsShopsPrices.productId))
    .limit(limit);

  return rows.map((row) => ({
    productId: row.productId,
    productName: row.productName,
    shopId: row.shopId as RecoverableShopId,
    url: row.url,
    api: row.api,
    locationId: row.locationId,
    currentPrice: row.currentPrice,
    regularPrice: row.regularPrice,
    updateAt: row.updateAt,
    hidden: row.hidden,
  }));
}

function logPrefix(row: HiddenProductRecoveryRow): string {
  return `productId=${row.productId} shopId=${row.shopId} url=${row.url}`;
}

async function processHiddenProduct(
  row: HiddenProductRecoveryRow,
  timeoutMs: number,
  maxRetries: number
): Promise<void> {
  const key = deriveRecoveryKeyFromRow(row);
  const attempt = await recoverHiddenProduct(row, key, {
    timeoutMs,
    maxRetries,
  });

  if (key) {
    await upsertRecoveryKey(row, key, {
      verifiedAt: attempt.status === "verified" ? new Date() : undefined,
    });
  }

  await upsertRecoveryReview(row, key, attempt);

  if (attempt.status === "verified") {
    console.log(
      `[DONE] ${logPrefix(row)} externalId=${attempt.proposal.externalId} proposedUrl=${attempt.proposal.proposedUrl}`
    );
    return;
  }

  console.error(
    `[FAIL] ${logPrefix(row)} externalId=${attempt.externalId ?? "missing"} reason=${attempt.reason}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const productsPerShop = parseNumberArg(args, "--products-per-shop", 5);
  const delayMinMs = parseNumberArg(args, "--delay-min", 600);
  const delayMaxMs = parseNumberArg(args, "--delay-max", 1200);
  const timeoutMs = parseNumberArg(args, "--timeout", 10000);
  const maxRetries = parseNumberArg(args, "--retries", 3);
  const selectedShopIds =
    parseRecoverableShopIdsArg(args, "--shop-id") ?? RECOVERABLE_SHOP_IDS;

  await ensureRecoverySchema();

  const perShopProducts = await Promise.all(
    selectedShopIds.map((shopId) => getHiddenProductsForShop(shopId, productsPerShop))
  );
  const totalProducts = perShopProducts.reduce(
    (sum, rows) => sum + rows.length,
    0
  );

  console.log(
    `[INFO] ${totalProducts} hidden products found across ${selectedShopIds.length} recoverable shops`
  );

  const totalRounds = Math.max(0, ...perShopProducts.map((rows) => rows.length));
  console.time("recover-hidden-products");

  for (let round = 0; round < totalRounds; round += 1) {
    const roundRows = perShopProducts
      .map((rows) => rows[round])
      .filter((row): row is HiddenProductRecoveryRow => Boolean(row));

    if (roundRows.length === 0) {
      break;
    }

    console.log(
      `[INFO] Round ${round + 1}/${totalRounds} - Processing ${roundRows.length} hidden products`
    );

    await Promise.all(
      roundRows.map((row) => processHiddenProduct(row, timeoutMs, maxRetries))
    );

    if (round < totalRounds - 1 && roundRows.length > 0) {
      await randomDelay(delayMinMs, delayMaxMs);
    }
  }

  console.timeEnd("recover-hidden-products");
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[ERROR] hidden product recovery failed", error);
    await closeDb();
    process.exit(1);
  });
