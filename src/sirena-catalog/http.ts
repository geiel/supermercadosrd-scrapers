import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fetchWithRetry, getSirenaHeaders } from "../http-client.js";
import type { FetchWithRetryConfig } from "../types.js";
import { mapWithConcurrency } from "../utils.js";
import type {
  SirenaCatalogCandidate,
  SirenaCategoryPageProduct,
  SirenaTopLevelCategory,
} from "./types.js";
import { shouldIgnoreSirenaCatalogProduct } from "./rules.js";

const rawCategoryNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    friendlyurl: z.string(),
    imagen: z.string().nullable().optional(),
    children: z.array(rawCategoryNodeSchema),
  }).transform((node) => ({
    id: node.id,
    name: node.name,
    friendlyUrl: node.friendlyurl,
    imageUrl: node.imagen ?? null,
    children: node.children,
  }))
);

const categoriesResponseSchema = z.object({
  data: z.array(rawCategoryNodeSchema),
});

const categoryPageResponseSchema = z
  .object({
    per_page: z.number(),
    current_page: z.number(),
    total: z.number(),
    category: z.string().nullable().optional(),
    base_img: z.string(),
    data: z.array(
      z.object({
        thumbs: z.string().nullable().optional(),
        friendlyurl: z.string(),
        name: z.string(),
        category: z.string().nullable().optional(),
        productid: z.string(),
      })
    ),
  })
  .transform((payload) => ({
    perPage: payload.per_page,
    currentPage: payload.current_page,
    total: payload.total,
    category: payload.category ?? null,
    baseImageUrl: payload.base_img,
    data: payload.data.map(
      (product): SirenaCategoryPageProduct => ({
        productId: product.productid,
        friendlyUrl: product.friendlyurl,
        name: product.name,
        categoryName: product.category ?? null,
        imageUrl: product.thumbs ?? null,
      })
    ),
  }));

function encodeBase64(value: string) {
  return Buffer.from(value).toString("base64");
}

function encodeNumberHeader(value: number) {
  return encodeBase64(String(value));
}

export function buildSirenaProductUrl(friendlyUrl: string) {
  return `https://sirena.do/products/index/${friendlyUrl}`;
}

export function buildSirenaProductApi(friendlyUrl: string) {
  return `https://st.sirena.do/product/detail/${encodeBase64(
    friendlyUrl
  )}==/Yzg4NDRhYWRjMTE5ZTE4NjU5N2Y1ZGVhZjlhNDViMDk=`;
}

function buildCategoryFeedUrl(friendlyUrl: string) {
  return `https://st.sirena.do/product/category/${encodeBase64(
    friendlyUrl
  )}/${randomUUID()}`;
}

function buildCategoriesUrl() {
  return `https://st.sirena.do/product/categories/${randomUUID()}`;
}

const sirenaOriginalImageBaseUrl =
  "https://assets-sirenago.s3-us-west-1.amazonaws.com/product/original/";

function normalizeOriginalImageUrl(
  baseImageUrl: string,
  thumbs: string | null | undefined
) {
  if (!thumbs) {
    return null;
  }

  if (thumbs.startsWith("http://") || thumbs.startsWith("https://")) {
    return thumbs.replace("/product/thumbs/", "/product/original/");
  }

  const normalizedBaseImageUrl =
    baseImageUrl.replace("/product/thumbs/", "/product/original/") ||
    sirenaOriginalImageBaseUrl;

  return `${normalizedBaseImageUrl.replace(/\/$/, "")}/${thumbs.replace(/^\/+/, "")}`;
}

export async function fetchSirenaTopLevelCategories(
  requestConfig?: FetchWithRetryConfig
): Promise<SirenaTopLevelCategory[]> {
  const response = await fetchWithRetry(
    buildCategoriesUrl(),
    {
      headers: getSirenaHeaders(),
    },
    requestConfig
  );

  if (!response) {
    throw new Error("Sirena categories request failed.");
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  const parsed = categoriesResponseSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    throw new Error("Invalid Sirena categories payload.");
  }

  return parsed.data.data.map((category) => ({
    name: category.name,
    friendlyUrl: category.friendlyUrl,
    imageUrl: category.imageUrl,
  }));
}

export async function fetchSirenaCategoryPage(
  category: SirenaTopLevelCategory,
  page: number,
  pageSize: number,
  requestConfig?: FetchWithRetryConfig
) {
  const response = await fetchWithRetry(
    buildCategoryFeedUrl(category.friendlyUrl),
    {
      headers: {
        ...getSirenaHeaders(),
        "x-p": encodeNumberHeader(page),
        "x-s": encodeNumberHeader(1),
        "x-l": encodeNumberHeader(pageSize),
      },
    },
    requestConfig
  );

  if (!response) {
    throw new Error(`Sirena category request failed for ${category.friendlyUrl}.`);
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  const parsed = categoryPageResponseSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    throw new Error(`Invalid Sirena category payload for ${category.friendlyUrl}.`);
  }

  return parsed.data;
}

export async function fetchSirenaCatalogCandidates(
  categories: SirenaTopLevelCategory[],
  {
    concurrency = 6,
    pageSize,
    requestConfig,
    onCategoryDiscovered,
    onPageFetched,
  }: {
    concurrency?: number;
    pageSize: number;
    requestConfig?: FetchWithRetryConfig;
    onCategoryDiscovered?: (input: {
      category: SirenaTopLevelCategory;
      totalProducts: number;
      totalPages: number;
    }) => void;
    onPageFetched?: (input: {
      category: SirenaTopLevelCategory;
      page: number;
      totalPages: number;
      pageProducts: number;
      aggregatedCandidates: number;
    }) => void;
  }
) {
  const aggregated = new Map<string, SirenaCatalogCandidate>();
  const categoryFirstPages = await mapWithConcurrency(
    categories,
    concurrency,
    async (category) => {
      const firstPage = await fetchSirenaCategoryPage(
        category,
        1,
        pageSize,
        requestConfig
      );

      const totalPages = Math.max(
        1,
        Math.ceil(firstPage.total / Math.max(firstPage.perPage, 1))
      );

      onCategoryDiscovered?.({
        category,
        totalProducts: firstPage.total,
        totalPages,
      });

      mergeCategoryProducts(
        aggregated,
        category,
        firstPage.baseImageUrl,
        firstPage.data
      );

      onPageFetched?.({
        category,
        page: 1,
        totalPages,
        pageProducts: firstPage.data.length,
        aggregatedCandidates: aggregated.size,
      });

      return {
        category,
        totalPages,
      };
    }
  );

  const remainingPages = categoryFirstPages.flatMap(({ category, totalPages }) =>
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => ({
      category,
      page: index + 2,
      totalPages,
    }))
  );

  await mapWithConcurrency(
    remainingPages,
    concurrency,
    async ({ category, page, totalPages }) => {
      const nextPage = await fetchSirenaCategoryPage(
        category,
        page,
        pageSize,
        requestConfig
      );

      mergeCategoryProducts(
        aggregated,
        category,
        nextPage.baseImageUrl,
        nextPage.data
      );

      onPageFetched?.({
        category,
        page,
        totalPages,
        pageProducts: nextPage.data.length,
        aggregatedCandidates: aggregated.size,
      });
    }
  );

  return Array.from(aggregated.values());
}

function mergeCategoryProducts(
  target: Map<string, SirenaCatalogCandidate>,
  category: SirenaTopLevelCategory,
  baseImageUrl: string,
  products: SirenaCategoryPageProduct[]
) {
  for (const product of products) {
    const categoryPath = [category.name, product.categoryName]
      .filter(Boolean)
      .join(" >> ");
    const ignoredByCategoryRule = shouldIgnoreSirenaCatalogProduct({
      productName: product.name,
      topLevelCategorySlug: category.friendlyUrl,
      categoryPath,
    });

    const candidate: SirenaCatalogCandidate = {
      productId: product.productId,
      friendlyUrl: product.friendlyUrl,
      canonicalUrl: buildSirenaProductUrl(product.friendlyUrl),
      api: buildSirenaProductApi(product.friendlyUrl),
      sourceCategoryUrl: `https://sirena.do/products/category/${category.friendlyUrl}`,
      topLevelCategorySlug: category.friendlyUrl,
      categoryPath,
      name: product.name,
      imageUrl: normalizeOriginalImageUrl(baseImageUrl, product.imageUrl),
      ignoredByCategoryRule,
    };

    const current = target.get(product.productId);
    if (!current) {
      target.set(product.productId, candidate);
      continue;
    }

    if (current.ignoredByCategoryRule && !candidate.ignoredByCategoryRule) {
      target.set(product.productId, candidate);
      continue;
    }

    if (current.ignoredByCategoryRule === candidate.ignoredByCategoryRule) {
      const currentPathLength = current.categoryPath.length;
      const nextPathLength = candidate.categoryPath.length;
      if (nextPathLength > currentPathLength) {
        target.set(product.productId, candidate);
      }
    }
  }
}
