import { z } from "zod";
import {
  SIRENA_CATEGORY_TREE_API_URL_TEMPLATE,
  SIRENA_PRODUCTS_SEARCH_API_URL,
  SIRENA_PRODUCT_API_URL_TEMPLATE,
} from "./api-endpoints.js";
import { fetchWithRetry, getSirenaHeaders } from "./http-client.js";
import type { FetchWithRetryConfig } from "./types.js";

const SIRENA_BASE_URL = "https://www.sirena.do";
const CATEGORY_TREE_DEPTH = 20;
const DEFAULT_CATEGORY_PAGE_SIZE = 50;

export const SIRENA_VTEX_IMAGE_PREFIXES = [
  "https://gruporamos.vtexassets.com/arquivos/",
  "https://gruporamos.vteximg.com.br/arquivos/",
] as const;

const sirenaVtexSellerOfferSchema = z
  .object({
    Price: z.number().nullable().optional(),
    ListPrice: z.number().nullable().optional(),
    AvailableQuantity: z.number().nullable().optional(),
    IsAvailable: z.boolean().nullable().optional(),
  })
  .passthrough();

const sirenaVtexSellerSchema = z
  .object({
    sellerDefault: z.boolean().nullable().optional(),
    commertialOffer: sirenaVtexSellerOfferSchema.nullable().optional(),
  })
  .passthrough();

const sirenaVtexImageSchema = z
  .object({
    imageUrl: z.string().nullable().optional(),
  })
  .passthrough();

const sirenaVtexItemSchema = z
  .object({
    itemId: z.union([z.string(), z.number()]),
    ean: z.union([z.string(), z.number()]).nullable().optional(),
    nameComplete: z.string().nullable().optional(),
    images: z.array(sirenaVtexImageSchema).optional().default([]),
    sellers: z.array(sirenaVtexSellerSchema).optional().default([]),
  })
  .passthrough();

const sirenaVtexProductSchema = z
  .object({
    productId: z.union([z.string(), z.number()]),
    productName: z.string(),
    brand: z.string().nullable().optional(),
    link: z.string().nullable().optional(),
    linkText: z.string().nullable().optional(),
    categories: z.array(z.string()).optional().default([]),
    categoryId: z.union([z.string(), z.number()]).nullable().optional(),
    productReference: z.string().nullable().optional(),
    productReferenceCode: z.string().nullable().optional(),
    items: z.array(sirenaVtexItemSchema).optional().default([]),
  })
  .passthrough();

const sirenaVtexProductsSchema = z.array(sirenaVtexProductSchema);

const rawCategoryNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    id: z.union([z.string(), z.number()]).transform((value) => Number(value)),
    name: z.string(),
    url: z.string(),
    children: z.array(rawCategoryNodeSchema).optional().default([]),
  })
);

const sirenaVtexCategoryTreeSchema = z.array(rawCategoryNodeSchema);

export type SirenaVtexProduct = z.infer<typeof sirenaVtexProductSchema>;

export type NormalizedSirenaVtexProduct = {
  productId: string;
  productName: string;
  brand: string | null;
  canonicalUrl: string;
  apiUrl: string;
  categoryId: string | null;
  categoryPath: string | null;
  productReference: string | null;
  currentPrice: string | null;
  regularPrice: string | null;
  images: string[];
  primaryImageUrl: string | null;
};

export type SirenaVtexCategoryNode = {
  id: number;
  name: string;
  url: string;
  children: SirenaVtexCategoryNode[];
};

export type FlattenedSirenaVtexCategory = {
  name: string;
  url: string;
  categoryIdPath: string;
  topLevelSlug: string;
  depth: number;
  isLeaf: boolean;
};

function normalizeString(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return "";
}

function toAbsoluteSirenaUrl(url: string | null | undefined) {
  const normalizedUrl = normalizeString(url);
  if (!normalizedUrl) {
    return "";
  }

  try {
    return new URL(normalizedUrl, SIRENA_BASE_URL).toString();
  } catch {
    return normalizedUrl;
  }
}

function normalizeTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function buildUrlFromTemplate(
  template: string,
  replacements: Record<string, string>
) {
  return Object.entries(replacements).reduce(
    (url, [key, value]) => url.replaceAll(`{${key}}`, value),
    template
  );
}

function appendSearchParams(endpoint: string, params: URLSearchParams) {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${params.toString()}`;
}

function toPriceString(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value.toFixed(2);
}

function getDefaultSeller(product: SirenaVtexProduct) {
  for (const item of product.items) {
    const defaultSeller =
      item.sellers.find((seller) => seller.sellerDefault === true) ??
      item.sellers[0];

    if (defaultSeller?.commertialOffer) {
      return defaultSeller;
    }
  }

  return null;
}

function categoryPathFromCategories(categories: string[]) {
  const firstCategory = categories.find((value) => normalizeString(value).length > 0);
  if (!firstCategory) {
    return null;
  }

  const segments = firstCategory
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.length > 0 ? segments.join(" >> ") : null;
}

function extractPathSegments(value: string) {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return [];
  }

  try {
    const url = new URL(normalizedValue, SIRENA_BASE_URL);
    return url.pathname.split("/").filter(Boolean);
  } catch {
    return normalizedValue.split("/").filter(Boolean);
  }
}

export function extractSirenaVtexProductSlug(value: string) {
  const segments = extractPathSegments(value);
  if (segments.length === 0) {
    return null;
  }

  const lastSegment = segments.at(-1)?.toLowerCase();
  if (lastSegment === "p") {
    return normalizeString(segments.at(-2));
  }

  if (
    segments[0] === "api" &&
    segments[1] === "catalog_system" &&
    segments[2] === "pub" &&
    segments[3] === "products" &&
    segments[4] === "search" &&
    lastSegment === "p"
  ) {
    return normalizeString(segments.at(-2));
  }

  if (segments.length === 1) {
    return normalizeString(segments[0]);
  }

  return null;
}

export function buildSirenaVtexProductApi(value: string) {
  const slug = extractSirenaVtexProductSlug(value);
  if (!slug) {
    return null;
  }

  return buildUrlFromTemplate(SIRENA_PRODUCT_API_URL_TEMPLATE, { slug });
}

export function buildSirenaVtexSearchUrl(query: string) {
  return `${SIRENA_BASE_URL}/busca?${new URLSearchParams({ ft: query }).toString()}`;
}

function buildSirenaVtexSearchApi(query: string, from: number, to: number) {
  const params = new URLSearchParams({
    ft: query,
    _from: String(from),
    _to: String(to),
  });

  return appendSearchParams(SIRENA_PRODUCTS_SEARCH_API_URL, params);
}

function buildSirenaVtexCategoryApi(categoryIdPath: string, from: number, to: number) {
  const params = new URLSearchParams({
    fq: `C:${categoryIdPath}`,
    _from: String(from),
    _to: String(to),
  });

  return appendSearchParams(SIRENA_PRODUCTS_SEARCH_API_URL, params);
}

async function fetchSirenaVtexJson(
  url: string,
  requestConfig?: FetchWithRetryConfig
): Promise<unknown> {
  const response = await fetchWithRetry(
    url,
    { headers: getSirenaHeaders() },
    requestConfig
  );

  if (!response?.ok) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function parseSirenaVtexProductsPayload(payload: unknown) {
  const parsed = sirenaVtexProductsSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export async function fetchSirenaVtexProductsByUrl(
  url: string,
  requestConfig?: FetchWithRetryConfig
) {
  const payload = await fetchSirenaVtexJson(url, requestConfig);
  return parseSirenaVtexProductsPayload(payload);
}

export async function fetchSirenaVtexProductByApiOrUrl(
  value: string,
  requestConfig?: FetchWithRetryConfig
) {
  const apiUrl = buildSirenaVtexProductApi(value);
  if (!apiUrl) {
    return null;
  }

  const products = await fetchSirenaVtexProductsByUrl(apiUrl, requestConfig);
  return products?.[0] ?? null;
}

export async function fetchSirenaVtexSearchProducts(
  query: string,
  limit = 12,
  requestConfig?: FetchWithRetryConfig
) {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const products = await fetchSirenaVtexProductsByUrl(
    buildSirenaVtexSearchApi(query, 0, safeLimit - 1),
    requestConfig
  );

  return products ?? [];
}

export async function fetchSirenaVtexCategoryProducts(
  categoryIdPath: string,
  page: number,
  pageSize = DEFAULT_CATEGORY_PAGE_SIZE,
  requestConfig?: FetchWithRetryConfig
) {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.max(1, Math.min(50, Math.floor(pageSize)));
  const from = (safePage - 1) * safePageSize;
  const to = from + safePageSize - 1;

  const products = await fetchSirenaVtexProductsByUrl(
    buildSirenaVtexCategoryApi(categoryIdPath, from, to),
    requestConfig
  );

  return products ?? [];
}

export function extractSirenaVtexImages(product: SirenaVtexProduct) {
  const images: string[] = [];
  const seen = new Set<string>();

  for (const item of product.items) {
    for (const image of item.images) {
      const imageUrl = normalizeString(image.imageUrl);
      if (!imageUrl || seen.has(imageUrl)) {
        continue;
      }

      seen.add(imageUrl);
      images.push(imageUrl);
    }
  }

  return images;
}

export function normalizeSirenaVtexProduct(
  product: SirenaVtexProduct
): NormalizedSirenaVtexProduct {
  const canonicalUrl = toAbsoluteSirenaUrl(
    product.link || (product.linkText ? `/${product.linkText}/p` : "")
  );
  const apiUrl =
    buildSirenaVtexProductApi(canonicalUrl || product.linkText || "") || "";
  const seller = getDefaultSeller(product);
  const offer = seller?.commertialOffer;
  const images = extractSirenaVtexImages(product);

  return {
    productId: normalizeString(product.productId),
    productName: normalizeString(product.productName),
    brand: normalizeString(product.brand) || null,
    canonicalUrl,
    apiUrl,
    categoryId: normalizeString(product.categoryId) || null,
    categoryPath: categoryPathFromCategories(product.categories),
    productReference:
      normalizeString(product.productReferenceCode) ||
      normalizeString(product.productReference) ||
      null,
    currentPrice: toPriceString(offer?.Price),
    regularPrice:
      toPriceString(offer?.ListPrice) ?? toPriceString(offer?.Price) ?? null,
    images,
    primaryImageUrl: images[0] ?? null,
  };
}

export async function fetchSirenaVtexCategoryTree(
  requestConfig?: FetchWithRetryConfig
) {
  const payload = await fetchSirenaVtexJson(
    buildUrlFromTemplate(SIRENA_CATEGORY_TREE_API_URL_TEMPLATE, {
      depth: String(CATEGORY_TREE_DEPTH),
    }),
    requestConfig
  );

  const parsed = sirenaVtexCategoryTreeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Invalid Sirena VTEX category tree payload.");
  }

  const normalizeNode = (node: unknown): SirenaVtexCategoryNode => {
    const record =
      typeof node === "object" && node !== null
        ? (node as Record<string, unknown>)
        : {};
    const children = Array.isArray(record.children) ? record.children : [];

    return {
      id: Number(record.id),
      name: normalizeString(record.name),
      url: toAbsoluteSirenaUrl(normalizeString(record.url)),
      children: children.map((child) => normalizeNode(child)),
    };
  };

  return parsed.data.map((node) => normalizeNode(node));
}

export function extractSirenaTopLevelSlug(categoryUrl: string) {
  const segments = extractPathSegments(categoryUrl);
  return normalizeString(segments.at(-1)).toLowerCase();
}

export function findSirenaCategoryIdPathByUrl(
  nodes: SirenaVtexCategoryNode[],
  targetUrl: string,
  parentIds: number[] = []
): string | null {
  const normalizedTargetUrl = normalizeTrailingSlash(targetUrl);

  for (const node of nodes) {
    const currentIds = [...parentIds, node.id];

    if (normalizeTrailingSlash(node.url) === normalizedTargetUrl) {
      return `/${currentIds.join("/")}`;
    }

    const childMatch = findSirenaCategoryIdPathByUrl(
      node.children,
      targetUrl,
      currentIds
    );
    if (childMatch) {
      return childMatch;
    }
  }

  return null;
}

export function flattenSirenaVtexCategoryTree(
  nodes: SirenaVtexCategoryNode[],
  parentIds: number[] = [],
  topLevelSlug = "",
  depth = 0
): FlattenedSirenaVtexCategory[] {
  const result: FlattenedSirenaVtexCategory[] = [];

  for (const node of nodes) {
    const currentIds = [...parentIds, node.id];
    const currentTopLevelSlug = topLevelSlug || extractSirenaTopLevelSlug(node.url);

    result.push({
      name: node.name,
      url: node.url,
      categoryIdPath: `/${currentIds.join("/")}`,
      topLevelSlug: currentTopLevelSlug,
      depth,
      isLeaf: node.children.length === 0,
    });

    result.push(
      ...flattenSirenaVtexCategoryTree(
        node.children,
        currentIds,
        currentTopLevelSlug,
        depth + 1
      )
    );
  }

  return result;
}
