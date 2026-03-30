#!/usr/bin/env node

import type { ScrapePriceResult } from "../types.js";
import { closeDb } from "../db/client.js";
import { ensureNacionalCatalogSchema } from "../db/ensure-nacional-catalog-schema.js";
import { ensureRecoverySchema } from "../db/ensure-recovery-schema.js";
import {
  fetchNacionalCatalogProducts,
  fetchNacionalSitemapEntries,
} from "../nacional-catalog/http.js";
import {
  findExistingNacionalReferences,
  findGlobalIdMatches,
  getCatalogStateMap,
  upsertCatalogSyncState,
} from "../nacional-catalog/store.js";
import type {
  ExistingNacionalReference,
  ExistingProductMatch,
  MatchResolution,
  NacionalCatalogProduct,
  NacionalSitemapEntry,
} from "../nacional-catalog/types.js";
import type { HiddenProductRecoveryRow, RecoveryAttempt } from "../recovery/types.js";
import { randomDelay } from "../utils.js";
import { scrapeNacionalPrice } from "../shops/nacional.js";
import { upsertRecoveryKey, upsertRecoveryReview } from "../recovery/store.js";

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

function sameDate(left: Date | null | undefined, right: Date | null | undefined) {
  const leftTime = left?.getTime() ?? null;
  const rightTime = right?.getTime() ?? null;
  return leftTime === rightTime;
}

function shouldProcessEntry(input: {
  entry: NacionalSitemapEntry;
  state:
    | {
        canonicalUrl: string;
        sitemapLastmod: Date | null;
        syncStatus: string;
        lastProcessedAt: Date | null;
      }
    | undefined;
  retryAfterHours: number;
  force: boolean;
}) {
  if (input.force) {
    return true;
  }

  if (!input.state) {
    return true;
  }

  if (input.state.canonicalUrl !== input.entry.canonicalUrl) {
    return true;
  }

  if (!sameDate(input.state.sitemapLastmod, input.entry.lastmod)) {
    return true;
  }

  if (
    input.state.syncStatus !== "proposal_ready" &&
    input.state.syncStatus !== "no_reference_change"
  ) {
    const lastProcessedAt = input.state.lastProcessedAt?.getTime() ?? 0;
    const retryWindowMs = input.retryAfterHours * 60 * 60 * 1000;
    return Date.now() - lastProcessedAt >= retryWindowMs;
  }

  return false;
}

function createCandidateEvidence(
  entry: NacionalSitemapEntry,
  candidate: NacionalCatalogProduct,
  extra: Record<string, unknown> = {}
) {
  return {
    sku: candidate.sku,
    candidateName: candidate.name,
    candidateUrl: candidate.canonicalUrl,
    imageUrl: candidate.imageUrl,
    eans: candidate.eans,
    sitemapUrl: entry.sitemapUrl,
    sitemapLastmod: entry.lastmod?.toISOString() ?? null,
    ...extra,
  };
}

function toUniqueMatches<T extends { productId: number }>(rows: T[]): T[] {
  const byProductId = new Map<number, T>();
  for (const row of rows) {
    if (!byProductId.has(row.productId)) {
      byProductId.set(row.productId, row);
    }
  }

  return Array.from(byProductId.values());
}

function resolveMatch(input: {
  candidate: NacionalCatalogProduct;
  existingReferences: ExistingNacionalReference[];
  globalIdMatches: ExistingProductMatch[];
}): MatchResolution {
  const existingReferences = toUniqueMatches(input.existingReferences);
  const globalIdMatches = toUniqueMatches(input.globalIdMatches);
  const globalMatchIds = new Set(globalIdMatches.map((row) => row.productId));

  if (existingReferences.length === 1) {
    const liveReference = existingReferences[0];
    if (globalIdMatches.length === 1 && !globalMatchIds.has(liveReference.productId)) {
      return {
        kind: "conflicting_match_signals",
        reason: "Existing Nacional reference and barcode match point to different products.",
        evidence: {
          existingReferenceProductId: liveReference.productId,
          globalIdProductId: globalIdMatches[0]?.productId ?? null,
        },
      };
    }

    const normalizedCurrentUrl = liveReference.url.trim().replace(/\/+$/, "");
    const normalizedCandidateUrl = input.candidate.canonicalUrl.trim().replace(/\/+$/, "");

    if (normalizedCurrentUrl === normalizedCandidateUrl && liveReference.hidden !== true) {
      return {
        kind: "no_reference_change",
        matchedProductId: liveReference.productId,
        matchStrategy: "existing_reference",
        liveReference,
      };
    }

    return {
      kind: "proposal_target",
      matchedProductId: liveReference.productId,
      matchStrategy: "existing_reference",
      liveReference,
    };
  }

  if (existingReferences.length > 1) {
    if (globalIdMatches.length === 1) {
      const matchingReference = existingReferences.find(
        (row) => row.productId === globalIdMatches[0]?.productId
      );

      if (matchingReference) {
        const normalizedCurrentUrl = matchingReference.url
          .trim()
          .replace(/\/+$/, "");
        const normalizedCandidateUrl = input.candidate.canonicalUrl
          .trim()
          .replace(/\/+$/, "");

        if (
          normalizedCurrentUrl === normalizedCandidateUrl &&
          matchingReference.hidden !== true
        ) {
          return {
            kind: "no_reference_change",
            matchedProductId: matchingReference.productId,
            matchStrategy: "existing_reference",
            liveReference: matchingReference,
          };
        }

        return {
          kind: "proposal_target",
          matchedProductId: matchingReference.productId,
          matchStrategy: "existing_reference",
          liveReference: matchingReference,
        };
      }
    }

    return {
      kind: "ambiguous_existing_reference",
      reason: "Multiple existing Nacional references match this catalog SKU.",
      evidence: {
        existingReferenceProductIds: existingReferences.map((row) => row.productId),
      },
    };
  }

  if (globalIdMatches.length === 1) {
    return {
      kind: "proposal_target",
      matchedProductId: globalIdMatches[0].productId,
      matchStrategy: "barcode",
      liveReference: null,
    };
  }

  if (globalIdMatches.length > 1) {
    return {
      kind: "ambiguous_global_id_match",
      reason: "Multiple products share the same candidate barcode set.",
      evidence: {
        globalIdProductIds: globalIdMatches.map((row) => row.productId),
      },
    };
  }

  return {
    kind: "unmatched_catalog_product",
    reason: "No existing Nacional reference or unique barcode match found.",
    evidence: {},
  };
}

function toRecoveryRow(
  resolution: Extract<MatchResolution, { kind: "proposal_target" | "no_reference_change" }>
): HiddenProductRecoveryRow {
  if (resolution.liveReference) {
    return {
      productId: resolution.liveReference.productId,
      productName: resolution.liveReference.productName,
      shopId: 2,
      url: resolution.liveReference.url,
      api: resolution.liveReference.api,
      locationId: resolution.liveReference.locationId,
      currentPrice: resolution.liveReference.currentPrice,
      regularPrice: resolution.liveReference.regularPrice,
      updateAt: resolution.liveReference.updateAt,
      hidden: resolution.liveReference.hidden,
    };
  }

  return {
    productId: resolution.matchedProductId,
    productName: null,
    shopId: 2,
    url: "",
    api: null,
    locationId: null,
    currentPrice: null,
    regularPrice: null,
    updateAt: null,
    hidden: null,
  };
}

function buildAttemptFromScrapeResult(input: {
  entry: NacionalSitemapEntry;
  candidate: NacionalCatalogProduct;
  resolution: Extract<MatchResolution, { kind: "proposal_target" }>;
  result: ScrapePriceResult;
}): RecoveryAttempt {
  const evidence = createCandidateEvidence(input.entry, input.candidate, {
    matchStrategy: input.resolution.matchStrategy,
    matchedProductId: input.resolution.matchedProductId,
  });

  if (input.result.status === "ok") {
    return {
      status: "verified",
      proposal: {
        recoveryMethod: "nacional_catalog_sitemap",
        externalIdType: "sku",
        externalId: input.candidate.sku,
        proposedUrl: input.candidate.canonicalUrl,
        proposedApi: null,
        proposedLocationId: input.result.locationId ?? null,
        proposedCurrentPrice: input.result.currentPrice,
        proposedRegularPrice: input.result.regularPrice,
        evidence,
      },
    };
  }

  return {
    status: "failed",
    recoveryMethod: "nacional_catalog_sitemap",
    externalIdType: "sku",
    externalId: input.candidate.sku,
    reason: input.result.reason,
    evidence: {
      ...evidence,
      scrapeStatus: input.result.status,
      hide: input.result.hide,
      retryable: input.result.status === "error" ? input.result.retryable : false,
    },
  };
}

async function processEntry(input: {
  entry: NacionalSitemapEntry;
  candidate: NacionalCatalogProduct;
  timeoutMs: number;
  maxRetries: number;
}) {
  const existingReferences = await findExistingNacionalReferences(input.candidate);
  const globalIdMatches = await findGlobalIdMatches(input.candidate.eans);
  const resolution = resolveMatch({
    candidate: input.candidate,
    existingReferences,
    globalIdMatches,
  });

  if (resolution.kind === "no_reference_change") {
    await upsertCatalogSyncState({
      entry: input.entry,
      candidate: input.candidate,
      syncStatus: "no_reference_change",
      matchedProductId: resolution.matchedProductId,
      sourcePayload: createCandidateEvidence(input.entry, input.candidate, {
        matchStrategy: resolution.matchStrategy,
      }),
    });

    console.log(
      `[IGNORE] sku=${input.candidate.sku} productId=${resolution.matchedProductId} reason=no_reference_change`
    );
    return;
  }

  if (resolution.kind !== "proposal_target") {
    await upsertCatalogSyncState({
      entry: input.entry,
      candidate: input.candidate,
      syncStatus: resolution.kind,
      failureReason: resolution.reason,
      sourcePayload: createCandidateEvidence(input.entry, input.candidate, resolution.evidence),
    });

    console.log(
      `[SKIP] sku=${input.candidate.sku} reason=${resolution.kind} note=${resolution.reason}`
    );
    return;
  }

  const recoveryRow = toRecoveryRow(resolution);
  const scrapeResult = await scrapeNacionalPrice(
    {
      shopId: 2,
      url: input.candidate.canonicalUrl,
    },
    {
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries,
    }
  );

  const attempt = buildAttemptFromScrapeResult({
    entry: input.entry,
    candidate: input.candidate,
    resolution,
    result: scrapeResult,
  });

  const recoveryKey = {
    externalIdType: "sku" as const,
    externalId: input.candidate.sku,
    source: "nacional_catalog_sitemap",
  };

  await upsertRecoveryKey(recoveryRow, recoveryKey, {
    verifiedAt: attempt.status === "verified" ? new Date() : undefined,
  });
  await upsertRecoveryReview(recoveryRow, recoveryKey, attempt);

  await upsertCatalogSyncState({
    entry: input.entry,
    candidate: input.candidate,
    syncStatus: attempt.status === "verified" ? "proposal_ready" : "verification_failed",
    matchedProductId: resolution.matchedProductId,
    failureReason: attempt.status === "verified" ? null : attempt.reason,
    sourcePayload:
      attempt.status === "verified"
        ? attempt.proposal.evidence
        : attempt.evidence,
  });

  if (attempt.status === "verified") {
    console.log(
      `[DONE] sku=${input.candidate.sku} productId=${resolution.matchedProductId} proposedUrl=${attempt.proposal.proposedUrl}`
    );
    return;
  }

  console.error(
    `[FAIL] sku=${input.candidate.sku} productId=${resolution.matchedProductId} reason=${attempt.reason}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const limit = parseNumberArg(args, "--limit", 200);
  const retryAfterHours = parseNumberArg(args, "--retry-hours", 24);
  const delayMinMs = parseNumberArg(args, "--delay-min", 300);
  const delayMaxMs = parseNumberArg(args, "--delay-max", 800);
  const timeoutMs = parseNumberArg(args, "--timeout", 15000);
  const maxRetries = parseNumberArg(args, "--retries", 3);
  const restBatchSize = parseNumberArg(args, "--rest-batch-size", 25);
  const force = parseBooleanArg(args, "--force");

  await Promise.all([ensureRecoverySchema(), ensureNacionalCatalogSchema()]);

  const [entries, stateMap] = await Promise.all([
    fetchNacionalSitemapEntries({ timeoutMs, maxRetries }),
    getCatalogStateMap(),
  ]);

  const pendingEntries = entries
    .filter((entry) =>
      shouldProcessEntry({
        entry,
        state: stateMap.get(entry.sku),
        retryAfterHours,
        force,
      })
    )
    .slice(0, limit);

  console.log(
    `[INFO] sitemapEntries=${entries.length} pendingEntries=${pendingEntries.length} limit=${limit}`
  );

  if (pendingEntries.length === 0) {
    return;
  }

  const catalogProducts = await fetchNacionalCatalogProducts(
    pendingEntries,
    { timeoutMs, maxRetries },
    restBatchSize
  );

  console.time("sync-nacional-catalog");

  for (let index = 0; index < pendingEntries.length; index += 1) {
    const entry = pendingEntries[index];
    const candidate = catalogProducts.get(entry.sku);

    console.log(
      `[INFO] ${index + 1}/${pendingEntries.length} processing sku=${entry.sku}`
    );

    if (!candidate) {
      await upsertCatalogSyncState({
        entry,
        syncStatus: "rest_product_missing",
        failureReason: "Nacional REST lookup did not return this SKU.",
        sourcePayload: {
          sku: entry.sku,
          sitemapUrl: entry.sitemapUrl,
          sitemapLastmod: entry.lastmod?.toISOString() ?? null,
        },
      });

      console.error(`[FAIL] sku=${entry.sku} reason=rest_product_missing`);
    } else {
      await processEntry({
        entry,
        candidate,
        timeoutMs,
        maxRetries,
      });
    }

    if (index < pendingEntries.length - 1) {
      await randomDelay(delayMinMs, delayMaxMs);
    }
  }

  console.timeEnd("sync-nacional-catalog");
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[ERROR] Nacional catalog sync failed", error);
    await closeDb();
    process.exit(1);
  });
