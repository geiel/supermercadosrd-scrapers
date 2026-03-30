#!/usr/bin/env node

import type { ScrapePriceResult } from "../types.js";
import { closeDb } from "../db/client.js";
import { ensureRecoverySchema } from "../db/ensure-recovery-schema.js";
import { ensureSirenaCatalogSchema } from "../db/ensure-sirena-catalog-schema.js";
import {
  fetchSirenaCatalogCandidates,
  fetchSirenaTopLevelCategories,
} from "../sirena-catalog/http.js";
import {
  findExistingSirenaReferences,
  findSirenaRecoveryKeyMatches,
  getCatalogStateMap,
  upsertCatalogSyncState,
} from "../sirena-catalog/store.js";
import type {
  ExistingProductMatch,
  ExistingSirenaReference,
  MatchResolution,
  SirenaCatalogCandidate,
} from "../sirena-catalog/types.js";
import type { HiddenProductRecoveryRow, RecoveryAttempt } from "../recovery/types.js";
import { randomDelay } from "../utils.js";
import { scrapeSirenaPrice } from "../shops/sirena.js";
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

function parseEnvBoolean(value: string | undefined) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeNullableText(value: string | null | undefined) {
  return value?.trim().replace(/\/+$/, "") || null;
}

function shouldProcessCandidate(input: {
  candidate: SirenaCatalogCandidate;
  state:
    | {
        canonicalUrl: string;
        api: string;
        imageUrl: string | null;
        categoryPath: string | null;
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

  if (normalizeNullableText(input.state.canonicalUrl) !== input.candidate.canonicalUrl) {
    return true;
  }

  if (normalizeNullableText(input.state.api) !== input.candidate.api) {
    return true;
  }

  if (normalizeNullableText(input.state.imageUrl) !== input.candidate.imageUrl) {
    return true;
  }

  if (
    normalizeNullableText(input.state.categoryPath) !==
    normalizeNullableText(input.candidate.categoryPath)
  ) {
    return true;
  }

  if (
    input.state.syncStatus === "proposal_ready" ||
    input.state.syncStatus === "no_reference_change" ||
    input.state.syncStatus === "ignored_by_category_rule"
  ) {
    return false;
  }

  const lastProcessedAt = input.state.lastProcessedAt?.getTime() ?? 0;
  const retryWindowMs = input.retryAfterHours * 60 * 60 * 1000;
  return Date.now() - lastProcessedAt >= retryWindowMs;
}

function createCandidateEvidence(
  candidate: SirenaCatalogCandidate,
  extra: Record<string, unknown> = {}
) {
  return {
    productId: candidate.productId,
    friendlyUrl: candidate.friendlyUrl,
    candidateName: candidate.name,
    candidateUrl: candidate.canonicalUrl,
    candidateApi: candidate.api,
    imageUrl: candidate.imageUrl,
    sourceCategoryUrl: candidate.sourceCategoryUrl,
    categoryPath: candidate.categoryPath,
    topLevelCategorySlug: candidate.topLevelCategorySlug,
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
  candidate: SirenaCatalogCandidate;
  existingReferences: ExistingSirenaReference[];
  recoveryKeyMatches: ExistingProductMatch[];
}): MatchResolution {
  const existingReferences = toUniqueMatches(input.existingReferences);
  const recoveryKeyMatches = toUniqueMatches(input.recoveryKeyMatches);
  const recoveryKeyIds = new Set(recoveryKeyMatches.map((row) => row.productId));

  if (existingReferences.length === 1) {
    const liveReference = existingReferences[0];
    if (
      recoveryKeyMatches.length === 1 &&
      !recoveryKeyIds.has(liveReference.productId)
    ) {
      return {
        kind: "conflicting_match_signals",
        reason: "Existing Sirena reference and recovery key point to different products.",
        evidence: {
          existingReferenceProductId: liveReference.productId,
          recoveryKeyProductId: recoveryKeyMatches[0]?.productId ?? null,
        },
      };
    }

    const currentUrl = normalizeNullableText(liveReference.url);
    const candidateUrl = normalizeNullableText(input.candidate.canonicalUrl);
    const currentApi = normalizeNullableText(liveReference.api);
    const candidateApi = normalizeNullableText(input.candidate.api);

    if (
      currentUrl === candidateUrl &&
      currentApi === candidateApi &&
      liveReference.hidden !== true
    ) {
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
    if (recoveryKeyMatches.length === 1) {
      const matchingReference = existingReferences.find(
        (row) => row.productId === recoveryKeyMatches[0]?.productId
      );

      if (matchingReference) {
        const currentUrl = normalizeNullableText(matchingReference.url);
        const candidateUrl = normalizeNullableText(input.candidate.canonicalUrl);
        const currentApi = normalizeNullableText(matchingReference.api);
        const candidateApi = normalizeNullableText(input.candidate.api);

        if (
          currentUrl === candidateUrl &&
          currentApi === candidateApi &&
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
      reason: "Multiple existing Sirena references match this catalog product.",
      evidence: {
        existingReferenceProductIds: existingReferences.map((row) => row.productId),
      },
    };
  }

  if (recoveryKeyMatches.length === 1) {
    return {
      kind: "proposal_target",
      matchedProductId: recoveryKeyMatches[0].productId,
      matchStrategy: "recovery_key",
      liveReference: null,
    };
  }

  if (recoveryKeyMatches.length > 1) {
    return {
      kind: "ambiguous_recovery_key_match",
      reason: "Multiple products share the same Sirena recovery key.",
      evidence: {
        recoveryKeyProductIds: recoveryKeyMatches.map((row) => row.productId),
      },
    };
  }

  return {
    kind: "unmatched_catalog_product",
    reason: "No existing Sirena reference or recovery key match found.",
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
      shopId: 1,
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
    shopId: 1,
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
  candidate: SirenaCatalogCandidate;
  resolution: Extract<MatchResolution, { kind: "proposal_target" }>;
  result: ScrapePriceResult;
}): RecoveryAttempt {
  const evidence = createCandidateEvidence(input.candidate, {
    matchStrategy: input.resolution.matchStrategy,
    matchedProductId: input.resolution.matchedProductId,
  });

  if (input.result.status === "ok") {
    return {
      status: "verified",
      proposal: {
        recoveryMethod: "sirena_catalog_category_feed",
        externalIdType: "productid",
        externalId: input.candidate.productId,
        proposedUrl: input.candidate.canonicalUrl,
        proposedApi: input.candidate.api,
        proposedLocationId: input.result.locationId ?? null,
        proposedCurrentPrice: input.result.currentPrice,
        proposedRegularPrice: input.result.regularPrice,
        evidence,
      },
    };
  }

  return {
    status: "failed",
    recoveryMethod: "sirena_catalog_category_feed",
    externalIdType: "productid",
    externalId: input.candidate.productId,
    reason: input.result.reason,
    evidence: {
      ...evidence,
      scrapeStatus: input.result.status,
      hide: input.result.hide,
      retryable: input.result.status === "error" ? input.result.retryable : false,
    },
  };
}

async function processCandidate(input: {
  candidate: SirenaCatalogCandidate;
  timeoutMs: number;
  maxRetries: number;
}) {
  if (input.candidate.ignoredByCategoryRule) {
    await upsertCatalogSyncState({
      candidate: input.candidate,
      syncStatus: "ignored_by_category_rule",
      sourcePayload: createCandidateEvidence(input.candidate, {
        ignoreReason:
          "Product belongs to an excluded Sirena top-level category and did not match an allowed exception.",
      }),
    });

    console.log(
      `[IGNORE] productId=${input.candidate.productId} reason=ignored_by_category_rule`
    );
    return;
  }

  const existingReferences = await findExistingSirenaReferences(input.candidate);
  const recoveryKeyMatches = await findSirenaRecoveryKeyMatches(
    input.candidate.productId
  );
  const resolution = resolveMatch({
    candidate: input.candidate,
    existingReferences,
    recoveryKeyMatches,
  });

  if (resolution.kind === "no_reference_change") {
    await upsertCatalogSyncState({
      candidate: input.candidate,
      syncStatus: "no_reference_change",
      matchedProductId: resolution.matchedProductId,
      sourcePayload: createCandidateEvidence(input.candidate, {
        matchStrategy: resolution.matchStrategy,
      }),
    });

    console.log(
      `[IGNORE] productId=${input.candidate.productId} productDbId=${resolution.matchedProductId} reason=no_reference_change`
    );
    return;
  }

  if (resolution.kind !== "proposal_target") {
    await upsertCatalogSyncState({
      candidate: input.candidate,
      syncStatus: resolution.kind,
      failureReason: resolution.reason,
      sourcePayload: createCandidateEvidence(input.candidate, resolution.evidence),
    });

    console.log(
      `[SKIP] productId=${input.candidate.productId} reason=${resolution.kind} note=${resolution.reason}`
    );
    return;
  }

  const recoveryRow = toRecoveryRow(resolution);
  const scrapeResult = await scrapeSirenaPrice(
    {
      shopId: 1,
      url: input.candidate.canonicalUrl,
      api: input.candidate.api,
    },
    {
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries,
    }
  );

  const attempt = buildAttemptFromScrapeResult({
    candidate: input.candidate,
    resolution,
    result: scrapeResult,
  });

  const recoveryKey = {
    externalIdType: "productid" as const,
    externalId: input.candidate.productId,
    source: "sirena_catalog_category_feed",
  };

  await upsertRecoveryKey(recoveryRow, recoveryKey, {
    verifiedAt: attempt.status === "verified" ? new Date() : undefined,
  });
  await upsertRecoveryReview(recoveryRow, recoveryKey, attempt);

  await upsertCatalogSyncState({
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
      `[DONE] productId=${input.candidate.productId} productDbId=${resolution.matchedProductId} proposedUrl=${attempt.proposal.proposedUrl}`
    );
    return;
  }

  console.error(
    `[FAIL] productId=${input.candidate.productId} productDbId=${resolution.matchedProductId} reason=${attempt.reason}`
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
  const pageSize = parseNumberArg(args, "--page-size", 100);
  const concurrency = parseNumberArg(args, "--concurrency", 6);
  const force = parseBooleanArg(args, "--force");
  const skipSchemaEnsure = parseEnvBoolean(process.env.SKIP_SCHEMA_ENSURE);

  console.log(
    `[INFO] Starting Sirena catalog sync limit=${limit} pageSize=${pageSize} concurrency=${concurrency} retryAfterHours=${retryAfterHours} timeoutMs=${timeoutMs} maxRetries=${maxRetries} force=${force} skipSchemaEnsure=${skipSchemaEnsure}`
  );

  if (skipSchemaEnsure) {
    console.log("[INFO] Skipping schema bootstrap");
  } else {
    await ensureRecoverySchema();
    await ensureSirenaCatalogSchema();
  }

  console.log("[INFO] Fetching Sirena top-level categories");
  const [categories, stateMap] = await Promise.all([
    fetchSirenaTopLevelCategories({ timeoutMs, maxRetries }),
    getCatalogStateMap(),
  ]);

  console.log(
    `[INFO] Loaded top-level categories count=${categories.length}. Fetching category feeds...`
  );

  const candidates = await fetchSirenaCatalogCandidates(categories, {
    concurrency,
    pageSize,
    requestConfig: {
      timeoutMs,
      maxRetries,
    },
    onCategoryDiscovered: ({ category, totalProducts, totalPages }) => {
      console.log(
        `[DISCOVER] category=${category.friendlyUrl} totalProducts=${totalProducts} totalPages=${totalPages}`
      );
    },
    onPageFetched: ({
      category,
      page,
      totalPages,
      pageProducts,
      aggregatedCandidates,
    }) => {
      console.log(
        `[FETCH] category=${category.friendlyUrl} page=${page}/${totalPages} pageProducts=${pageProducts} aggregatedCandidates=${aggregatedCandidates}`
      );
    },
  });

  const pendingCandidates = candidates
    .filter((candidate) =>
      shouldProcessCandidate({
        candidate,
        state: stateMap.get(candidate.productId),
        retryAfterHours,
        force,
      })
    )
    .slice(0, limit);

  console.log(
    `[INFO] topLevelCategories=${categories.length} catalogCandidates=${candidates.length} pendingCandidates=${pendingCandidates.length} limit=${limit}`
  );

  if (pendingCandidates.length === 0) {
    return;
  }

  console.time("sync-sirena-catalog");

  for (let index = 0; index < pendingCandidates.length; index += 1) {
    const candidate = pendingCandidates[index];

    console.log(
      `[INFO] ${index + 1}/${pendingCandidates.length} processing productId=${candidate.productId} friendlyUrl=${candidate.friendlyUrl}`
    );

    await processCandidate({
      candidate,
      timeoutMs,
      maxRetries,
    });

    if (index < pendingCandidates.length - 1) {
      await randomDelay(delayMinMs, delayMaxMs);
    }
  }

  console.timeEnd("sync-sirena-catalog");
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[ERROR] Sirena catalog sync failed", error);
    await closeDb();
    process.exit(1);
  });
