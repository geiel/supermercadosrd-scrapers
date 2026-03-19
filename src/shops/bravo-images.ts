import { fetchWithRetry, getBravoHeaders } from "../http-client.js";
import { dedupeUrls, isRecord, normalizeString } from "../image-utils.js";
import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "../types.js";

const shopId = 6;
const shopName = "bravo";
const bravoImageBaseUrl =
  "https://bravova-resources.superbravo.com.do/images/catalogo/big";
const bravoDefaultImageVersion = "0";
const bravoMaxImageSuffix = 8;
const bravoImageMissStreakToStop = 2;
const bravoImageTimeoutMs = 8000;

function extractIdArticuloFromApi(apiUrl: string | null | undefined) {
  const normalizedApiUrl = normalizeString(apiUrl);
  if (!normalizedApiUrl) {
    return "";
  }

  try {
    const parsedUrl = new URL(normalizedApiUrl);
    return parsedUrl.searchParams.get("idArticulo")?.trim() ?? "";
  } catch {
    const match = normalizedApiUrl.match(/[?&]idArticulo=(\d+)/i);
    return match?.[1] ?? "";
  }
}

function buildBravoImageUrl(
  externalId: string,
  suffix: number,
  version: string
) {
  return `${bravoImageBaseUrl}/${encodeURIComponent(externalId)}_${suffix}.png?v=${encodeURIComponent(version)}`;
}

async function imageExists(url: string) {
  const requestInit = {
    cache: "no-store" as const,
    signal: AbortSignal.timeout(bravoImageTimeoutMs),
  };

  try {
    const headResponse = await fetch(url, {
      method: "HEAD",
      ...requestInit,
    });

    if (headResponse.ok) {
      return true;
    }

    if (headResponse.status !== 405) {
      return false;
    }
  } catch {
    // Continue with GET fallback below.
  }

  try {
    const getResponse = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      ...requestInit,
    });
    return getResponse.ok;
  } catch {
    return false;
  }
}

async function discoverBravoImagesByVersion(
  externalId: string,
  version: string
) {
  const discovered: string[] = [];
  let misses = 0;

  for (let suffix = 1; suffix <= bravoMaxImageSuffix; suffix += 1) {
    const imageUrl = buildBravoImageUrl(externalId, suffix, version);
    const exists = await imageExists(imageUrl);

    if (exists) {
      discovered.push(imageUrl);
      misses = 0;
      continue;
    }

    misses += 1;
    if (suffix > 1 && misses >= bravoImageMissStreakToStop) {
      break;
    }
  }

  return discovered;
}

export async function scrapeBravoImages(
  input: ScrapeProductImagesInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapeProductImagesResult> {
  if (!input.api) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "missing_api",
      retryable: false,
    };
  }

  const response = await fetchWithRetry(
    input.api,
    { headers: getBravoHeaders() },
    requestConfig
  );

  if (!response) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "request_failed",
      retryable: true,
    };
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!payload) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: "invalid_json",
      retryable: true,
    };
  }

  if (
    isRecord(payload) &&
    Array.isArray(payload.errors) &&
    payload.errors.length > 0
  ) {
    return {
      status: "not_found",
      shopId,
      shopName,
      reason: "product_not_found",
    };
  }

  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  const externalId = normalizeString(data?.idexternoArticulo);
  const imageCatalogVersion =
    normalizeString(data?.imageCatalogVersion) || bravoDefaultImageVersion;

  if (!externalId) {
    return {
      status: "error",
      shopId,
      shopName,
      reason: `missing_external_id:${extractIdArticuloFromApi(input.api)}`,
      retryable: false,
    };
  }

  const versionsToTry = Array.from(
    new Set([imageCatalogVersion, bravoDefaultImageVersion].filter(Boolean))
  );

  for (const version of versionsToTry) {
    const images = dedupeUrls(await discoverBravoImagesByVersion(externalId, version));
    if (images.length > 0) {
      return {
        status: "ok",
        shopId,
        shopName,
        images,
      };
    }
  }

  return {
    status: "not_found",
    shopId,
    shopName,
    reason: "image_not_found",
  };
}
