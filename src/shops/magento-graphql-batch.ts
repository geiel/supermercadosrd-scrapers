import { z } from "zod";
import { fetchWithRetryDetailed } from "../http-client.js";
import type { FetchWithRetryConfig } from "../types.js";

// Nacional, Jumbo and Merca Jumbo run on the same Magento backend. Its GraphQL
// `products(filter: { sku: { in: [...] } })` prices a whole batch of SKUs in
// one request instead of one request per product.

const batchResponseSchema = z.object({
  data: z.object({
    products: z.object({
      total_count: z.number().nullable().optional(),
      items: z.array(z.unknown()).nullable().optional(),
    }),
  }),
});

export type MagentoGraphqlBatchLookup<T> =
  | {
      ok: true;
      // null marks a listed SKU whose item did not match the schema; its row
      // gets the same invalid_payload error the single lookup returns.
      items: Map<string, T | null>;
      totalCount: number | null;
    }
  | { ok: false; reason: string };

export async function fetchMagentoGraphqlItemsBySku<T extends { sku: string }>(
  input: {
    url: string;
    storeCode: string;
    // Must declare `$skus: [String!]!` and `$pageSize: Int!`.
    query: string;
    skus: string[];
    itemSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
    headers?: Record<string, string>;
  },
  requestConfig?: FetchWithRetryConfig
): Promise<MagentoGraphqlBatchLookup<T>> {
  const { response, failureReason } = await fetchWithRetryDetailed(
    input.url,
    {
      method: "POST",
      headers: {
        ...input.headers,
        Accept: "application/json",
        "Content-Type": "application/json",
        store: input.storeCode,
      },
      body: JSON.stringify({
        query: input.query,
        variables: { skus: input.skus, pageSize: input.skus.length },
      }),
    },
    requestConfig
  );

  if (!response) {
    return { ok: false, reason: failureReason };
  }

  if (!response.ok) {
    return { ok: false, reason: `http_${response.status}` };
  }

  const parsed = batchResponseSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (!parsed.success) {
    return { ok: false, reason: "invalid_payload" };
  }

  const items = new Map<string, T | null>();
  for (const rawItem of parsed.data.data.products.items ?? []) {
    const item = input.itemSchema.safeParse(rawItem);
    if (item.success) {
      items.set(item.data.sku, item.data);
      continue;
    }

    const sku = (rawItem as { sku?: unknown } | null)?.sku;
    if (typeof sku === "string" && !items.has(sku)) {
      items.set(sku, null);
    }
  }

  return {
    ok: true,
    items,
    totalCount: parsed.data.data.products.total_count ?? null,
  };
}
