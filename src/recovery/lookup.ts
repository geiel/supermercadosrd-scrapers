import { z } from "zod";
import {
  fetchWithBrowserDetailed,
  fetchWithRetry,
  getPlazaLamaHeaders,
} from "../http-client.js";
import { scrapePrice } from "../scrape-price.js";
import type { FetchWithRetryConfig } from "../types.js";
import {
  PLAZA_LAMA_GRAPHQL_URL,
  buildJumboSearchUrl,
  buildNacionalLookupUrl,
  buildNacionalProductUrl,
  buildPlazaLamaProductUrl,
  extractJumboUrlTail,
  normalizeQuery,
  parseJumboSearchCandidates,
} from "./shared.js";
import type {
  HiddenProductRecoveryRow,
  RecoveryAttempt,
  RecoveryFailure,
  RecoveryKey,
  RecoveryMethod,
  RecoveryProposal,
} from "./types.js";

const nacionalLookupResponseSchema = z.object({
  items: z
    .array(
      z.object({
        sku: z.string(),
        name: z.string().optional(),
        custom_attributes: z
          .array(
            z.object({
              attribute_code: z.string(),
              value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
            })
          )
          .default([]),
      })
    )
    .default([]),
});

const plazaLamaLookupResponseSchema = z.array(
  z.object({
    data: z.object({
      getProductsBySKU: z
        .array(
          z.object({
            name: z.string().nullable().optional(),
            sku: z.string(),
            slug: z.string(),
            price: z.number(),
            promotion: z
              .object({
                conditions: z
                  .array(
                    z.object({
                      price: z.number(),
                    })
                  )
                  .default([]),
              })
              .nullable()
              .optional(),
          })
        )
        .default([]),
    }),
  })
);

const plazaLamaLookupQuery = `query GetProductsBySKU($getProductsBySKUInput: GetProductsBySKUInput!) {
  getProductsBySKU(getProductsBySKUInput: $getProductsBySKUInput) {
    name
    sku
    slug
    price
    promotion {
      conditions {
        price
      }
    }
  }
}`;

function buildFailure(
  reason: string,
  {
    recoveryMethod,
    key,
    evidence = {},
  }: {
    recoveryMethod: RecoveryMethod | null;
    key: RecoveryKey | null;
    evidence?: Record<string, unknown>;
  }
): RecoveryFailure {
  return {
    status: "failed",
    recoveryMethod,
    externalIdType: key?.externalIdType ?? null,
    externalId: key?.externalId ?? null,
    reason,
    evidence,
  };
}

function getRequestConfigWithDefaults(
  requestConfig: FetchWithRetryConfig | undefined,
  timeoutMs: number,
  maxRetries: number
): FetchWithRetryConfig {
  return {
    timeoutMs: Math.max(requestConfig?.timeoutMs ?? timeoutMs, timeoutMs),
    maxRetries: Math.max(requestConfig?.maxRetries ?? maxRetries, maxRetries),
  };
}

async function verifyProposal(
  row: HiddenProductRecoveryRow,
  proposal: Omit<
    RecoveryProposal,
    "proposedCurrentPrice" | "proposedRegularPrice" | "proposedLocationId"
  >,
  requestConfig?: FetchWithRetryConfig
): Promise<RecoveryAttempt> {
  const verificationResult = await scrapePrice(
    {
      shopId: row.shopId,
      url: proposal.proposedUrl,
      api: proposal.proposedApi,
    },
    requestConfig
  );

  if (verificationResult.status !== "ok") {
    return buildFailure(
      verificationResult.status === "not_found"
        ? `verification_not_found:${verificationResult.reason}`
        : `verification_error:${verificationResult.reason}`,
      {
        recoveryMethod: proposal.recoveryMethod,
        key: {
          externalIdType: proposal.externalIdType,
          externalId: proposal.externalId,
          source: "recovery",
        },
        evidence: {
          ...proposal.evidence,
          verification: verificationResult,
        },
      }
    );
  }

  return {
    status: "verified",
    proposal: {
      ...proposal,
      proposedCurrentPrice: verificationResult.currentPrice,
      proposedRegularPrice: verificationResult.regularPrice,
      proposedLocationId: verificationResult.locationId ?? null,
      evidence: {
        ...proposal.evidence,
        verification: verificationResult,
      },
    },
  };
}

async function recoverNacional(
  row: HiddenProductRecoveryRow,
  key: RecoveryKey,
  requestConfig?: FetchWithRetryConfig
): Promise<RecoveryAttempt> {
  const lookupUrl = buildNacionalLookupUrl(key.externalId);
  const response = await fetchWithRetry(
    lookupUrl,
    {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    },
    getRequestConfigWithDefaults(requestConfig, 20000, 2)
  );

  if (!response) {
    return buildFailure("lookup_request_failed", {
      recoveryMethod: "nacional_sku_lookup",
      key,
      evidence: { lookupUrl },
    });
  }

  if (!response.ok) {
    return buildFailure(`lookup_http_${response.status}`, {
      recoveryMethod: "nacional_sku_lookup",
      key,
      evidence: { lookupUrl },
    });
  }

  const payload = nacionalLookupResponseSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (!payload.success) {
    return buildFailure("lookup_invalid_payload", {
      recoveryMethod: "nacional_sku_lookup",
      key,
      evidence: { lookupUrl },
    });
  }

  const item =
    payload.data.items.find((candidate) => candidate.sku === key.externalId) ??
    payload.data.items[0];

  if (!item) {
    return buildFailure("lookup_product_not_found", {
      recoveryMethod: "nacional_sku_lookup",
      key,
      evidence: { lookupUrl },
    });
  }

  const attributes = new Map(
    item.custom_attributes.map((attribute) => [
      attribute.attribute_code,
      attribute.value,
    ])
  );
  const urlPath = attributes.get("url_path") ?? attributes.get("url_key");

  if (typeof urlPath !== "string" || !urlPath.trim()) {
    return buildFailure("lookup_missing_url_path", {
      recoveryMethod: "nacional_sku_lookup",
      key,
      evidence: {
        lookupUrl,
        sku: item.sku,
      },
    });
  }

  return verifyProposal(
    row,
    {
      recoveryMethod: "nacional_sku_lookup",
      externalIdType: key.externalIdType,
      externalId: key.externalId,
      proposedUrl: buildNacionalProductUrl(urlPath),
      proposedApi: null,
      evidence: {
        lookupUrl,
        sku: item.sku,
        productName: item.name ?? null,
        urlPath,
      },
    },
    requestConfig
  );
}

async function recoverJumbo(
  row: HiddenProductRecoveryRow,
  key: RecoveryKey,
  requestConfig?: FetchWithRetryConfig
): Promise<RecoveryAttempt> {
  const searchQuery = normalizeQuery(row.productName ?? "");

  if (!searchQuery) {
    return buildFailure("missing_product_name", {
      recoveryMethod: "jumbo_url_tail_search",
      key,
      evidence: {
        currentUrl: row.url,
      },
    });
  }

  const searchUrl = buildJumboSearchUrl(searchQuery);
  const searchResult = await fetchWithBrowserDetailed(
    searchUrl,
    Math.max(requestConfig?.timeoutMs ?? 10000, 45000)
  );

  if (!searchResult.ok) {
    return buildFailure(`search_${searchResult.reason}`, {
      recoveryMethod: "jumbo_url_tail_search",
      key,
      evidence: {
        searchUrl,
        searchQuery,
      },
    });
  }

  const candidates = parseJumboSearchCandidates(searchResult.html);
  const matchedCandidate = candidates.find(
    (candidate) => extractJumboUrlTail(candidate.url) === key.externalId
  );

  if (!matchedCandidate) {
    return buildFailure("search_match_not_found", {
      recoveryMethod: "jumbo_url_tail_search",
      key,
      evidence: {
        searchUrl,
        searchQuery,
        candidateCount: candidates.length,
        candidateUrls: candidates.slice(0, 12).map((candidate) => candidate.url),
      },
    });
  }

  return verifyProposal(
    row,
    {
      recoveryMethod: "jumbo_url_tail_search",
      externalIdType: key.externalIdType,
      externalId: key.externalId,
      proposedUrl: matchedCandidate.url,
      proposedApi: null,
      evidence: {
        searchUrl,
        searchQuery,
        matchedCandidate,
      },
    },
    requestConfig
  );
}

async function recoverPlazaLama(
  row: HiddenProductRecoveryRow,
  key: RecoveryKey,
  requestConfig?: FetchWithRetryConfig
): Promise<RecoveryAttempt> {
  const payload = [
    {
      operationName: "GetProductsBySKU",
      variables: {
        getProductsBySKUInput: {
          clientId: "PLAZA_LAMA",
          skus: [key.externalId],
          storeReference: "PL08-D",
        },
      },
      query: plazaLamaLookupQuery,
    },
  ];

  const response = await fetchWithRetry(
    PLAZA_LAMA_GRAPHQL_URL,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: getPlazaLamaHeaders(),
    },
    getRequestConfigWithDefaults(requestConfig, 20000, 2)
  );

  if (!response) {
    return buildFailure("lookup_request_failed", {
      recoveryMethod: "plaza_lama_sku_lookup",
      key,
      evidence: {
        sku: key.externalId,
      },
    });
  }

  if (!response.ok) {
    return buildFailure(`lookup_http_${response.status}`, {
      recoveryMethod: "plaza_lama_sku_lookup",
      key,
      evidence: {
        sku: key.externalId,
      },
    });
  }

  const parsed = plazaLamaLookupResponseSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (!parsed.success) {
    return buildFailure("lookup_invalid_payload", {
      recoveryMethod: "plaza_lama_sku_lookup",
      key,
      evidence: {
        sku: key.externalId,
      },
    });
  }

  const item = parsed.data[0]?.data.getProductsBySKU[0];
  if (!item) {
    return buildFailure("lookup_product_not_found", {
      recoveryMethod: "plaza_lama_sku_lookup",
      key,
      evidence: {
        sku: key.externalId,
      },
    });
  }

  return verifyProposal(
    row,
    {
      recoveryMethod: "plaza_lama_sku_lookup",
      externalIdType: key.externalIdType,
      externalId: key.externalId,
      proposedUrl: buildPlazaLamaProductUrl(item.slug),
      proposedApi: item.sku,
      evidence: {
        sku: item.sku,
        slug: item.slug,
        productName: item.name ?? null,
        lookupPrice: item.price,
        lookupPromoPrice: item.promotion?.conditions[0]?.price ?? null,
      },
    },
    requestConfig
  );
}

export async function recoverHiddenProduct(
  row: HiddenProductRecoveryRow,
  key: RecoveryKey | null,
  requestConfig?: FetchWithRetryConfig
): Promise<RecoveryAttempt> {
  if (!key) {
    return buildFailure("missing_external_id", {
      recoveryMethod: null,
      key: null,
      evidence: {
        currentUrl: row.url,
        currentApi: row.api,
      },
    });
  }

  switch (row.shopId) {
    case 2:
      return recoverNacional(row, key, requestConfig);
    case 3:
      return recoverJumbo(row, key, requestConfig);
    case 4:
      return recoverPlazaLama(row, key, requestConfig);
    default:
      return buildFailure("unsupported_shop", {
        recoveryMethod: null,
        key,
      });
  }
}
