#!/usr/bin/env node

import { closeDb, postgresClient } from "../db/client.js";
import { revalidateProduct } from "../db/revalidate-product.js";
import { remoteImageExists } from "../image-exists.js";
import { normalizeString } from "../image-utils.js";
import { mapWithConcurrency } from "../utils.js";

type BravoSecondImageFixCandidate = {
  reportId: number;
  productId: number;
  productName: string;
  beforeImageUrl: string;
  externalId: string;
  currentImageUrl: string;
  currentHidden: boolean;
  currentPrimary: boolean;
  productTableImageUrl: string | null;
  createdAt: Date | null;
};

type RevertResult = "reverted" | "dry_run" | "not_working" | "skipped";

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

function parseBooleanArg(args: Map<string, string>, key: string) {
  return args.get(key) === "true";
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

function normalizeBoolean(value: unknown) {
  return value === true || value === "true";
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

function mapCandidate(row: Record<string, unknown>): BravoSecondImageFixCandidate {
  return {
    reportId: normalizeNumber(row.reportId),
    productId: normalizeNumber(row.productId),
    productName: normalizeString(row.productName),
    beforeImageUrl: normalizeString(row.beforeImageUrl),
    externalId: normalizeString(row.externalId),
    currentImageUrl: normalizeString(row.currentImageUrl),
    currentHidden: normalizeBoolean(row.currentHidden),
    currentPrimary: normalizeBoolean(row.currentPrimary),
    productTableImageUrl: normalizeString(row.productTableImageUrl) || null,
    createdAt: normalizeDate(row.createdAt),
  };
}

function isBravoImageWithSuffix(
  imageUrl: string | null,
  externalId: string,
  suffix: 1 | 2
) {
  const normalizedImageUrl = normalizeString(imageUrl);
  if (!normalizedImageUrl || !externalId) {
    return false;
  }

  return new RegExp(
    `bravova-resources\\.superbravo\\.com\\.do/images/catalogo/big/${externalId}_${suffix}\\.png(?:[?#]|$)`,
    "i"
  ).test(normalizedImageUrl);
}

async function getBravoSecondImageFixCandidates(limit: number) {
  const rows = await postgresClient`
    with latest_reports as (
      select distinct on (
        "productId",
        substring("beforeImageUrl" from '/big/([0-9]+)_2\\.png')
      )
        id as "reportId",
        "productId",
        "beforeImageUrl",
        substring("beforeImageUrl" from '/big/([0-9]+)_2\\.png') as "externalId",
        "createdAt"
      from product_image_update_reports
      where "beforeImageUrl" ~ 'bravova-resources\\.superbravo\\.com\\.do/.*/[0-9]+_2\\.png'
        and "afterImageUrl" ~ 'bravova-resources\\.superbravo\\.com\\.do/.*/[0-9]+_1\\.png'
      order by
        "productId",
        substring("beforeImageUrl" from '/big/([0-9]+)_2\\.png'),
        "createdAt" desc,
        id desc
    ),
    current_front_images as (
      select
        latest_reports."reportId",
        latest_reports."productId",
        latest_reports."beforeImageUrl",
        latest_reports."externalId",
        latest_reports."createdAt",
        products.name as "productName",
        products.image as "productTableImageUrl",
        product_images."imageUrl" as "currentImageUrl",
        product_images.hidden as "currentHidden",
        product_images."primary" as "currentPrimary",
        row_number() over (
          partition by latest_reports."productId", latest_reports."externalId"
          order by product_images."imageUrl"
        ) as row_number
      from latest_reports
      inner join products
        on products.id = latest_reports."productId"
      inner join product_images
        on product_images."productId" = latest_reports."productId"
        and product_images."imageUrl" ~ (
          'bravova-resources\\.superbravo\\.com\\.do/images/catalogo/big/' ||
          latest_reports."externalId" ||
          '_1\\.png'
        )
      left join product_images restored_second_image
        on restored_second_image."productId" = latest_reports."productId"
        and restored_second_image."imageUrl" ~ (
          'bravova-resources\\.superbravo\\.com\\.do/images/catalogo/big/' ||
          latest_reports."externalId" ||
          '_2\\.png'
        )
      where restored_second_image."imageUrl" is null
        and coalesce(products.deleted, false) = false
    )
    select
      "reportId",
      "productId",
      "productName",
      "beforeImageUrl",
      "externalId",
      "currentImageUrl",
      "currentHidden",
      "currentPrimary",
      "productTableImageUrl",
      "createdAt"
    from current_front_images
    where row_number = 1
    order by "createdAt" desc, "reportId" desc
    limit ${limit}
  `;

  return rows.map((row) => mapCandidate(row as Record<string, unknown>));
}

async function revertCandidate(
  candidate: BravoSecondImageFixCandidate,
  options: {
    dryRun: boolean;
    skipRevalidate: boolean;
    timeoutMs: number;
  }
): Promise<RevertResult> {
  if (candidate.currentPrimary) {
    console.log(
      `[SKIP] reportId=${candidate.reportId} productId=${candidate.productId} reason=current_bravo_front_image_is_primary currentImage=${candidate.currentImageUrl}`
    );
    return "skipped";
  }

  if (
    isBravoImageWithSuffix(
      candidate.productTableImageUrl,
      candidate.externalId,
      1
    )
  ) {
    console.log(
      `[SKIP] reportId=${candidate.reportId} productId=${candidate.productId} reason=current_bravo_front_image_is_product_table_image currentImage=${candidate.currentImageUrl}`
    );
    return "skipped";
  }

  const beforeImageStillWorks = await remoteImageExists(
    candidate.beforeImageUrl,
    { timeoutMs: options.timeoutMs }
  );

  if (!beforeImageStillWorks) {
    console.log(
      `[SKIP] reportId=${candidate.reportId} productId=${candidate.productId} reason=bravo_second_image_not_working beforeImage=${candidate.beforeImageUrl}`
    );
    return "not_working";
  }

  if (options.dryRun) {
    console.log(
      `[DRY_RUN] reportId=${candidate.reportId} productId=${candidate.productId} restoreImage=${candidate.beforeImageUrl} removeImage=${candidate.currentImageUrl}`
    );
    return "dry_run";
  }

  await postgresClient.begin(async (tx) => {
    const transaction = tx as unknown as typeof postgresClient;

    await transaction`
      insert into product_images ("productId", "imageUrl", hidden, "primary")
      values (
        ${candidate.productId},
        ${candidate.beforeImageUrl},
        ${candidate.currentHidden},
        false
      )
      on conflict ("productId", "imageUrl") do update
      set hidden = excluded.hidden,
          "primary" = false
    `;

    await transaction`
      delete from product_images
      where "productId" = ${candidate.productId}
        and "imageUrl" = ${candidate.currentImageUrl}
        and coalesce("primary", false) = false
    `;

    await transaction`
      delete from product_broken_images
      where "productId" = ${candidate.productId}
        and "imageUrl" = ${candidate.beforeImageUrl}
    `;
  });

  if (!options.skipRevalidate) {
    await revalidateProduct(candidate.productId);
  }

  console.log(
    `[REVERTED] reportId=${candidate.reportId} productId=${candidate.productId} restoreImage=${candidate.beforeImageUrl} removedImage=${candidate.currentImageUrl}`
  );

  return "reverted";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const limit = parseNumberArg(args, "--limit", 1000);
  const concurrency = parseNumberArg(args, "--concurrency", 4);
  const timeoutMs = parseNumberArg(args, "--timeout", 8000);
  const dryRun = parseBooleanArg(args, "--dry-run");
  const skipRevalidate = parseBooleanArg(args, "--skip-revalidate");

  const candidates = await getBravoSecondImageFixCandidates(limit);

  console.log(
    `[INFO] Found ${candidates.length} Bravo _2 image fixes to inspect dryRun=${dryRun}`
  );

  const results = await mapWithConcurrency(candidates, concurrency, (candidate) =>
    revertCandidate(candidate, {
      dryRun,
      skipRevalidate,
      timeoutMs,
    })
  );

  const summary = results.reduce(
    (acc, result) => {
      acc[result] += 1;
      return acc;
    },
    {
      reverted: 0,
      dry_run: 0,
      not_working: 0,
      skipped: 0,
    } satisfies Record<RevertResult, number>
  );

  console.log(`[DONE] ${JSON.stringify(summary)}`);
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[ERROR] revert Bravo second image fixes failed", error);
    await closeDb();
    process.exit(1);
  });
