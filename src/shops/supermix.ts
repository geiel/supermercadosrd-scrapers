import { z } from "zod";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

// Supermix runs on Shopify. Prices come from the Storefront API, which resolves
// up to 250 products per request, so a full refresh needs only a few requests.
// This module intentionally avoids ../http-client.js: that file loads every
// other shop's endpoint secrets, and Supermix must not depend on them.

export const SUPERMIX_SHOP_ID = 14;
export const SUPERMIX_ORIGIN = "https://supermix.com.do";
export const SUPERMIX_NODES_BATCH_SIZE = 250;
export const SUPERMIX_HANDLES_BATCH_SIZE = 50;

const shopId = SUPERMIX_SHOP_ID;
const USER_AGENT =
  "Mozilla/5.0 (compatible; SupermercadosRD-PriceSync/1.0; +https://supermercadosrd.com)";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 10000;

export type SupermixStorefrontConfig = {
  apiUrl: string;
  accessToken: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export function getSupermixStorefrontConfig(
  env: NodeJS.ProcessEnv = process.env
): SupermixStorefrontConfig {
  const apiUrl = env.SUPERMIX_STOREFRONT_API_URL?.trim();
  const accessToken = env.SUPERMIX_STOREFRONT_ACCESS_TOKEN?.trim();

  if (!apiUrl || !accessToken) {
    throw new Error(
      "SUPERMIX_STOREFRONT_API_URL and SUPERMIX_STOREFRONT_ACCESS_TOKEN are required"
    );
  }

  return { apiUrl, accessToken };
}

const GID_PATTERN = /^gid:\/\/shopify\/(Product|ProductVariant)\/(\d+)$/;

/** `api` holds a Product GID, or a ProductVariant GID for multi-variant products. */
export function parseSupermixGid(api: string | null | undefined) {
  const match = api?.trim().match(GID_PATTERN);
  if (!match) {
    return null;
  }

  return {
    gid: match[0],
    type: match[1] as "Product" | "ProductVariant",
    id: match[2],
  };
}

export function parseSupermixHandle(url: string | null | undefined) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!/(^|\.)supermix\.com\.do$/i.test(parsed.hostname)) {
      return null;
    }

    const match = parsed.pathname.match(/\/products\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]).toLowerCase() : null;
  } catch {
    return null;
  }
}

export function buildSupermixProductUrl(handle: string, variantId?: string | null) {
  const url = `${SUPERMIX_ORIGIN}/products/${encodeURIComponent(handle)}`;
  return variantId ? `${url}?variant=${variantId}` : url;
}

const moneySchema = z.object({ amount: z.string() });
const variantFieldsSchema = z.object({
  id: z.string(),
  availableForSale: z.boolean(),
  price: moneySchema,
  compareAtPrice: moneySchema.nullable(),
});
const nodeSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("Product"),
    id: z.string(),
    handle: z.string(),
    variants: z.object({ nodes: z.array(variantFieldsSchema) }),
  }),
  variantFieldsSchema.extend({
    __typename: z.literal("ProductVariant"),
    product: z.object({ handle: z.string() }),
  }),
]);

const VARIANT_FIELDS =
  "id availableForSale price { amount } compareAtPrice { amount }";
// variants(first: 2) is enough to detect products that need a variant GID.
const NODES_QUERY = `query SupermixPrices($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Product { id handle variants(first: 2) { nodes { ${VARIANT_FIELDS} } } }
    ... on ProductVariant { ${VARIANT_FIELDS} product { handle } }
  }
}`;

function toPositivePrice(amount: string | null | undefined) {
  const value = Number(amount);
  return amount && Number.isFinite(value) && value > 0 ? value.toFixed(2) : null;
}

export function toSupermixPriceResult(node: unknown): ScrapePriceResult {
  if (node === null || node === undefined) {
    return notFound(shopId, "product_not_found", true);
  }

  const parsed = nodeSchema.safeParse(node);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, false);
  }

  let variant: z.infer<typeof variantFieldsSchema>;
  let handle: string;
  let variantId: string | null = null;

  if (parsed.data.__typename === "Product") {
    const variants = parsed.data.variants.nodes;
    if (variants.length === 0) {
      return notFound(shopId, "variant_not_found", true);
    }

    // The price depends on which variant was matched; store its GID in `api`.
    if (variants.length > 1) {
      return error(shopId, "multiple_variants", false, true);
    }

    variant = variants[0];
    handle = parsed.data.handle;
  } else {
    variant = parsed.data;
    handle = parsed.data.product.handle;
    variantId = parseSupermixGid(parsed.data.id)?.id ?? null;
  }

  if (!variant.availableForSale) {
    return notFound(shopId, "unavailable", true);
  }

  const currentPrice = toPositivePrice(variant.price.amount);
  if (!currentPrice) {
    return notFound(shopId, "price_not_found", true);
  }

  const compareAtPrice = toPositivePrice(variant.compareAtPrice?.amount);
  const regularPrice =
    compareAtPrice && Number(compareAtPrice) > Number(currentPrice)
      ? compareAtPrice
      : null;

  return ok(
    shopId,
    currentPrice,
    regularPrice,
    null,
    buildSupermixProductUrl(handle, variantId)
  );
}

type StorefrontResponse =
  | { ok: true; data: Record<string, unknown>; apiVersion: string | null }
  | { ok: false; reason: string };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

async function postStorefront(
  query: string,
  variables: Record<string, unknown>,
  config: SupermixStorefrontConfig
): Promise<StorefrontResponse> {
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastReason = "request_failed";
  let nextDelayMs = retryDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(nextDelayMs);
      nextDelayMs = retryDelayMs * 3 ** (attempt - 1);
    }

    let response: Response;
    try {
      response = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "X-Shopify-Storefront-Access-Token": config.accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (fetchError) {
      lastReason =
        fetchError instanceof Error && fetchError.name === "TimeoutError"
          ? "timeout"
          : "network_error";
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      lastReason = `http_${response.status}`;
      const waitMs = retryAfterMs(response);
      if (waitMs) {
        nextDelayMs = Math.min(waitMs, 60000);
      }
      continue;
    }

    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }

    const body = (await response.json().catch(() => null)) as {
      data?: Record<string, unknown> | null;
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
    } | null;

    if (!body) {
      return { ok: false, reason: "invalid_json" };
    }

    if (body.errors?.length) {
      const code = body.errors[0]?.extensions?.code ?? "error";
      lastReason = `graphql_${code}`;
      if (code === "THROTTLED") {
        continue;
      }

      console.error(
        `[ERROR] supermix storefront ${lastReason}: ${body.errors[0]?.message ?? ""}`
      );
      return { ok: false, reason: lastReason };
    }

    if (!body.data) {
      return { ok: false, reason: "missing_data" };
    }

    return {
      ok: true,
      data: body.data,
      apiVersion: response.headers.get("x-shopify-api-version"),
    };
  }

  return { ok: false, reason: lastReason };
}

export async function fetchSupermixNodes(
  gids: string[],
  config: SupermixStorefrontConfig
): Promise<
  | { ok: true; nodesByGid: Map<string, unknown>; apiVersion: string | null }
  | { ok: false; reason: string }
> {
  if (gids.length > SUPERMIX_NODES_BATCH_SIZE) {
    throw new Error(`At most ${SUPERMIX_NODES_BATCH_SIZE} ids per request`);
  }

  const response = await postStorefront(NODES_QUERY, { ids: gids }, config);
  if (!response.ok) {
    return response;
  }

  const nodes = response.data.nodes;
  if (!Array.isArray(nodes) || nodes.length !== gids.length) {
    return { ok: false, reason: "invalid_nodes_payload" };
  }

  return {
    ok: true,
    nodesByGid: new Map(gids.map((gid, index) => [gid, nodes[index]])),
    apiVersion: response.apiVersion,
  };
}

/** Maps product handles (from `url`) to Product GIDs; null when unpublished. */
export async function resolveSupermixHandles(
  handles: string[],
  config: SupermixStorefrontConfig
): Promise<
  { ok: true; gidByHandle: Map<string, string | null> } | { ok: false; reason: string }
> {
  if (handles.length > SUPERMIX_HANDLES_BATCH_SIZE) {
    throw new Error(`At most ${SUPERMIX_HANDLES_BATCH_SIZE} handles per request`);
  }

  const variableDefinitions = handles.map((_, index) => `$h${index}: String!`);
  const fields = handles.map(
    (_, index) => `h${index}: product(handle: $h${index}) { id }`
  );
  const query = `query SupermixHandles(${variableDefinitions.join(", ")}) { ${fields.join(" ")} }`;
  const variables = Object.fromEntries(
    handles.map((handle, index) => [`h${index}`, handle])
  );

  const response = await postStorefront(query, variables, config);
  if (!response.ok) {
    return response;
  }

  const gidByHandle = new Map<string, string | null>();
  handles.forEach((handle, index) => {
    const product = response.data[`h${index}`] as { id?: unknown } | null | undefined;
    gidByHandle.set(
      handle,
      typeof product?.id === "string" ? parseSupermixGid(product.id)?.gid ?? null : null
    );
  });

  return { ok: true, gidByHandle };
}

/** Single-product lookup; the scheduled job uses the batch functions instead. */
export async function scrapeSupermixPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  let config: SupermixStorefrontConfig;
  try {
    config = {
      ...getSupermixStorefrontConfig(),
      timeoutMs: requestConfig?.timeoutMs,
      maxAttempts: requestConfig?.maxRetries,
    };
  } catch {
    return error(shopId, "missing_storefront_config", false, false);
  }

  let gid = parseSupermixGid(input.api)?.gid ?? null;
  if (!gid) {
    const handle = parseSupermixHandle(input.url);
    if (!handle) {
      return error(shopId, "missing_product_reference", false, false);
    }

    const resolved = await resolveSupermixHandles([handle], config);
    if (!resolved.ok) {
      return error(shopId, resolved.reason, true, false);
    }

    gid = resolved.gidByHandle.get(handle) ?? null;
    if (!gid) {
      return notFound(shopId, "product_not_found", true);
    }
  }

  const fetched = await fetchSupermixNodes([gid], config);
  if (!fetched.ok) {
    return error(shopId, fetched.reason, true, false);
  }

  return toSupermixPriceResult(fetched.nodesByGid.get(gid));
}
