#!/usr/bin/env node

import { and, asc, eq, sql } from "drizzle-orm";
import { applyProductImageFix, deleteBrokenImageReportsByImage } from "../db/apply-product-image-fix.js";
import { closeDb, db } from "../db/client.js";
import { productImages, productsShopsPrices } from "../db/schema.js";
import { getComparableImageKey, normalizeString } from "../image-utils.js";
import { scrapeProductImages } from "../scrape-product-images.js";
import type { FetchWithRetryConfig, ShopId } from "../types.js";
import { randomDelay } from "../utils.js";

type PendingBrokenImageCandidate = {
  brokenImageId: number;
  productId: number;
  productName: string;
  reportedImageUrl: string;
  productTableImageUrl: string | null;
  reportedAt: Date | null;
};

type ProductShopImageSource = {
  shopId: ShopId;
  url: string;
  api: string | null;
};

type ProductImageState = {
  imageUrl: string;
  hidden: boolean;
  primary: boolean;
};

type ProductImageResolution = {
  rows: ProductImageState[];
  shouldSyncProductTableImageAsPrimary: boolean;
  productTableProductImageRow: ProductImageState | null;
};

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

function normalizeNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function normalizeDate(value: unknown) {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsedDate = new Date(value);
    if (!Number.isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  }

  return null;
}

function mapPendingCandidate(row: Record<string, unknown>): PendingBrokenImageCandidate {
  return {
    brokenImageId: normalizeNumber(row.brokenImageId),
    productId: normalizeNumber(row.productId),
    productName: normalizeString(row.productName),
    reportedImageUrl: normalizeString(row.reportedImageUrl),
    productTableImageUrl: normalizeString(row.productTableImageUrl) || null,
    reportedAt: normalizeDate(row.reportedAt),
  };
}

async function getPendingBrokenImageCandidates(limit: number) {
  const rows = await db.execute(sql`
    with ranked_reports as (
      select
        pbi.id as "brokenImageId",
        pbi."productId",
        pbi."imageUrl" as "reportedImageUrl",
        pbi."reportedAt",
        row_number() over (
          partition by pbi."productId"
          order by pbi."reportedAt" asc, pbi.id asc
        ) as row_number
      from product_broken_images pbi
      inner join products p on p.id = pbi."productId"
      where coalesce(pbi."isFixed", false) = false
        and coalesce(p.deleted, false) = false
    )
    select
      rr."brokenImageId",
      rr."productId",
      rr."reportedImageUrl",
      rr."reportedAt",
      p.name as "productName",
      p.image as "productTableImageUrl"
    from ranked_reports rr
    inner join products p on p.id = rr."productId"
    where rr.row_number = 1
    order by rr."reportedAt" asc, rr."brokenImageId" asc
    limit ${limit}
  `);

  return rows.map((row) => mapPendingCandidate(row as Record<string, unknown>));
}

async function getProductShopImageSource(
  productId: number,
  shopId: ShopId
): Promise<ProductShopImageSource | null> {
  const row = await db
    .select({
      shopId: productsShopsPrices.shopId,
      url: productsShopsPrices.url,
      api: productsShopsPrices.api,
    })
    .from(productsShopsPrices)
    .where(
      and(
        eq(productsShopsPrices.productId, productId),
        eq(productsShopsPrices.shopId, shopId)
      )
    )
    .orderBy(asc(productsShopsPrices.shopId))
    .limit(1);

  return (row[0] as ProductShopImageSource | undefined) ?? null;
}

async function getProductImages(productId: number): Promise<ProductImageState[]> {
  const rows = await db
    .select({
      imageUrl: productImages.imageUrl,
      hidden: productImages.hidden,
      primary: productImages.primary,
    })
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.imageUrl));

  return rows as ProductImageState[];
}

function resolveProductImageState(
  productImageRows: ProductImageState[],
  productTableImageUrl: string | null,
  reportedImageUrl: string
): ProductImageResolution {
  const normalizedProductTableImageUrl = normalizeString(productTableImageUrl);
  const productTableImageKey = getComparableImageKey(normalizedProductTableImageUrl);
  const reportedImageKey = getComparableImageKey(reportedImageUrl);
  const productTableProductImageRow =
    productImageRows.find((row) => row.imageUrl === normalizedProductTableImageUrl) ?? null;
  const primaryRows = productImageRows.filter((row) => row.primary);

  if (
    !normalizedProductTableImageUrl ||
    productTableImageKey === reportedImageKey
  ) {
    return {
      rows: productImageRows,
      shouldSyncProductTableImageAsPrimary: false,
      productTableProductImageRow,
    };
  }

  const hasProductTableImageAsOnlyPrimary =
    primaryRows.length === 1 &&
    primaryRows[0].imageUrl === normalizedProductTableImageUrl;

  if (hasProductTableImageAsOnlyPrimary) {
    return {
      rows: productImageRows,
      shouldSyncProductTableImageAsPrimary: false,
      productTableProductImageRow,
    };
  }

  const nextRows = productImageRows.map((row) => ({
    ...row,
    primary: row.imageUrl === normalizedProductTableImageUrl,
  }));

  if (!productTableProductImageRow) {
    nextRows.push({
      imageUrl: normalizedProductTableImageUrl,
      hidden: false,
      primary: true,
    });
  }

  return {
    rows: nextRows,
    shouldSyncProductTableImageAsPrimary: true,
    productTableProductImageRow,
  };
}

function getShopIdFromImageUrl(imageUrl: string | null): ShopId | null {
  const normalizedImageUrl = normalizeString(imageUrl).toLowerCase();
  if (!normalizedImageUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(normalizedImageUrl);
    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname.toLowerCase();

    if (
      hostname === "assets-sirenago.s3-us-west-1.amazonaws.com" &&
      (pathname.startsWith("/product/original/") || pathname.startsWith("/product/large/"))
    ) {
      return 1;
    }

    if (
      hostname === "supermercadosnacional.com" &&
      pathname.startsWith("/media/catalog/")
    ) {
      return 2;
    }

    if (hostname === "jumbo.com.do" && pathname.startsWith("/pub/media/catalog/")) {
      return 3;
    }

    if (
      hostname === "img.plazalama.com.do"
    ) {
      return 4;
    }

    if (
      hostname === "d31f1ehqijlcua.cloudfront.net" ||
      hostname.includes("pricesmart.com")
    ) {
      return 5;
    }

    if (hostname === "bravova-resources.superbravo.com.do") {
      return 6;
    }
  } catch {
    // Fall through to substring checks below for malformed legacy URLs.
  }

  if (
    normalizedImageUrl.includes("assets-sirenago.s3-us-west-1.amazonaws.com/product/original/") ||
    normalizedImageUrl.includes("assets-sirenago.s3-us-west-1.amazonaws.com/product/large/")
  ) {
    return 1;
  }

  if (normalizedImageUrl.includes("supermercadosnacional.com/media/catalog/")) {
    return 2;
  }

  if (normalizedImageUrl.includes("jumbo.com.do/pub/media/catalog/")) {
    return 3;
  }

  if (
    normalizedImageUrl.includes("img.plazalama.com.do/")
  ) {
    return 4;
  }

  if (
    normalizedImageUrl.includes("d31f1ehqijlcua.cloudfront.net/") ||
    normalizedImageUrl.includes("pricesmart.com")
  ) {
    return 5;
  }

  if (normalizedImageUrl.includes("bravova-resources.superbravo.com.do")) {
    return 6;
  }

  return null;
}

function pickReplacementImage(
  images: string[],
  candidate: PendingBrokenImageCandidate
) {
  const reportedImageUrl = normalizeString(candidate.reportedImageUrl);
  const reportedImageKey = getComparableImageKey(reportedImageUrl);
  const primaryImageUrl = normalizeString(images[0]);

  if (!primaryImageUrl) {
    return null;
  }

  return getComparableImageKey(primaryImageUrl) !== reportedImageKey
    ? primaryImageUrl
    : null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
) {
  if (items.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, () => runWorker())
  );

  return results;
}

async function processBrokenImageCandidate(
  candidate: PendingBrokenImageCandidate,
  requestConfig: FetchWithRetryConfig
) {
  const reportedImageUrl = normalizeString(candidate.reportedImageUrl);
  const reportedImageKey = getComparableImageKey(reportedImageUrl);
  const productTableImageUrl = normalizeString(candidate.productTableImageUrl);
  const productTableImageKey = getComparableImageKey(productTableImageUrl);
  const initialProductImageRows = await getProductImages(candidate.productId);
  const resolvedProductImageState = resolveProductImageState(
    initialProductImageRows,
    productTableImageUrl,
    reportedImageUrl
  );
  const productImageRows = resolvedProductImageState.rows;
  const brokenProductImageRow =
    productImageRows.find(
      (row) => getComparableImageKey(row.imageUrl) === reportedImageKey
    ) ?? null;
  const primaryProductImageRow =
    productImageRows.find((row) => row.primary) ?? null;

  if (!brokenProductImageRow && productTableImageKey !== reportedImageKey) {
    await deleteBrokenImageReportsByImage(
      candidate.productId,
      candidate.reportedImageUrl
    );

    console.log(
      `[DONE/ALREADY_FIXED] brokenImageId=${candidate.brokenImageId} productId=${candidate.productId} reason=image_not_in_products_or_product_images`
    );

    return "already_fixed" as const;
  }

  const reportedImageShopId = getShopIdFromImageUrl(reportedImageUrl);

  if (!reportedImageShopId) {
    await deleteBrokenImageReportsByImage(
      candidate.productId,
      candidate.reportedImageUrl
    );

    console.log(
      `[IGNORE] brokenImageId=${candidate.brokenImageId} productId=${candidate.productId} reason=reported_image_shop_not_detected deletedReport=true`
    );
    return "unchanged" as const;
  }

  const source = await getProductShopImageSource(
    candidate.productId,
    reportedImageShopId
  );

  if (!source) {
    await deleteBrokenImageReportsByImage(
      candidate.productId,
      candidate.reportedImageUrl
    );

    console.log(
      `[SKIP] brokenImageId=${candidate.brokenImageId} productId=${candidate.productId} shopId=${reportedImageShopId} reason=no_matching_shop_source deletedReport=true`
    );
    return "no_sources" as const;
  }

  const result = await scrapeProductImages(source, requestConfig);

  if (result.status !== "ok") {
    console.log(
      `[INFO] brokenImageId=${candidate.brokenImageId} productId=${candidate.productId} shopId=${source.shopId} status=${result.status} reason=${result.reason}`
    );
  } else {
    const replacementImageUrl = pickReplacementImage(
      result.images,
      candidate
    );
    if (!replacementImageUrl) {
      console.log(
        `[INFO] brokenImageId=${candidate.brokenImageId} productId=${candidate.productId} shopId=${source.shopId} reason=no_different_image`
      );
    } else {
      const replacementImageKey = getComparableImageKey(replacementImageUrl);
      const replacementProductImageRow =
        productImageRows.find(
          (row) => getComparableImageKey(row.imageUrl) === replacementImageKey
        ) ?? null;
      const shouldUpdateProductTable =
        brokenProductImageRow?.primary === true ||
        (!primaryProductImageRow && productTableImageKey === reportedImageKey);

      if (
        brokenProductImageRow &&
        replacementProductImageRow &&
        (replacementProductImageRow.hidden !== brokenProductImageRow.hidden ||
          replacementProductImageRow.primary !== brokenProductImageRow.primary)
      ) {
        console.log(
          `[INFO] brokenImageId=${candidate.brokenImageId} productId=${candidate.productId} shopId=${source.shopId} reason=replacement_conflicts_with_existing_product_image_state`
        );
      } else {
        await applyProductImageFix({
          productId: candidate.productId,
          reportedImageUrl: candidate.reportedImageUrl,
          replacementImageUrl,
          productTableImageUrl,
          shouldSyncProductTableImageAsPrimary:
            resolvedProductImageState.shouldSyncProductTableImageAsPrimary,
          shouldUpdateProductTable,
          productTableProductImageRow:
            resolvedProductImageState.productTableProductImageRow,
          brokenProductImageRow,
          replacementProductImageRow,
        });

        console.log(
          `[DONE] brokenImageId=${candidate.brokenImageId} productId=${candidate.productId} shopId=${source.shopId} replacementImage=${replacementImageUrl} updateProductTable=${shouldUpdateProductTable} syncProductTableAsPrimary=${resolvedProductImageState.shouldSyncProductTableImageAsPrimary} brokenProductImagePrimary=${brokenProductImageRow?.primary ?? false} currentPrimaryImage=${primaryProductImageRow?.imageUrl ?? ""}`
        );

        return "updated" as const;
      }
    }
  }

  await deleteBrokenImageReportsByImage(
    candidate.productId,
    candidate.reportedImageUrl
  );

  console.log(
    `[IGNORE] brokenImageId=${candidate.brokenImageId} productId=${candidate.productId} reason=no_replacement_found deletedReport=true`
  );
  return "unchanged" as const;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const iterationCount = parseNumberArg(args, "--iterations", 40);
  const productsPerIteration = parseNumberArg(args, "--products-per-iteration", 5);
  const concurrency = parseNumberArg(args, "--concurrency", 2);
  const delayMinMs = parseNumberArg(args, "--delay-min", 600);
  const delayMaxMs = parseNumberArg(args, "--delay-max", 1200);
  const timeoutMs = parseNumberArg(args, "--timeout", 12000);
  const maxRetries = parseNumberArg(args, "--retries", 3);

  console.time("batch-broken-images");

  for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
    const iterationStart = Date.now();
    const candidates = await getPendingBrokenImageCandidates(productsPerIteration);

    if (candidates.length === 0) {
      console.log(
        `[INFO] Iteration ${iteration}/${iterationCount} - no pending broken images found`
      );
      break;
    }

    console.log(
      `[INFO] Iteration ${iteration}/${iterationCount} - processing ${candidates.length} products`
    );

    await mapWithConcurrency(candidates, concurrency, (candidate) =>
      processBrokenImageCandidate(candidate, {
        timeoutMs,
        maxRetries,
      })
    );

    if (iteration < iterationCount) {
      await randomDelay(delayMinMs, delayMaxMs);
    }

    console.log(
      `[INFO] Iteration ${iteration}/${iterationCount} completed in ${Date.now() - iterationStart}ms`
    );
  }

  console.timeEnd("batch-broken-images");
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[ERROR] broken images batch failed", error);
    await closeDb();
    process.exit(1);
  });
