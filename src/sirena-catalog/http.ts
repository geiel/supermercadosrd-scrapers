import { SIRENA_PRODUCT_API_URL_TEMPLATE } from "../api-endpoints.js";
import type { FetchWithRetryConfig } from "../types.js";
import { mapWithConcurrency } from "../utils.js";
import { shouldIgnoreSirenaCatalogProduct } from "./rules.js";
import type {
  SirenaCatalogCandidate,
  SirenaCatalogSubcategory,
  SirenaCategoryPageProduct,
  SirenaTopLevelCategory,
} from "./types.js";
import {
  buildSirenaVtexProductApi,
  flattenSirenaVtexCategoryTree,
  extractSirenaTopLevelSlug,
  extractSirenaVtexProductSlug,
  fetchSirenaVtexCategoryProducts,
  fetchSirenaVtexCategoryTree,
  normalizeSirenaVtexProduct,
} from "../sirena-vtex.js";

export function buildSirenaProductUrl(friendlyUrl: string) {
  return `https://www.sirena.do/${friendlyUrl}/p`;
}

export function buildSirenaProductApi(friendlyUrl: string) {
  return (
    buildSirenaVtexProductApi(friendlyUrl) ??
    SIRENA_PRODUCT_API_URL_TEMPLATE.replaceAll("{slug}", friendlyUrl)
  );
}

function normalizeCategoryProduct(product: ReturnType<typeof normalizeSirenaVtexProduct>): SirenaCategoryPageProduct {
  return {
    productId: product.productId,
    friendlyUrl: extractSirenaVtexProductSlug(product.canonicalUrl) ?? "",
    name: product.productName,
    categoryName: product.categoryPath,
    imageUrl: product.primaryImageUrl,
  };
}

export async function fetchSirenaTopLevelCategories(
  requestConfig?: FetchWithRetryConfig
): Promise<SirenaTopLevelCategory[]> {
  const tree = await fetchSirenaVtexCategoryTree(requestConfig);
  const flattenedCategories = flattenSirenaVtexCategoryTree(tree);

  return flattenedCategories
    .filter((category) => category.depth === 0)
    .map((category) => ({
      name: category.name,
      friendlyUrl: category.topLevelSlug || extractSirenaTopLevelSlug(category.url),
      url: category.url,
      categoryIdPath: category.categoryIdPath,
      imageUrl: null,
      subcategories: flattenedCategories
        .filter(
          (childCategory) =>
            childCategory.topLevelSlug === category.topLevelSlug &&
            childCategory.depth > 0 &&
            childCategory.isLeaf
        )
        .map(
          (childCategory): SirenaCatalogSubcategory => ({
            name: childCategory.name,
            url: childCategory.url,
            categoryIdPath: childCategory.categoryIdPath,
          })
        ),
    }));
}

async function fetchAllSirenaCategoryProducts(
  category: {
    name: string;
    url: string;
    categoryIdPath: string;
  },
  pageSize: number,
  requestConfig?: FetchWithRetryConfig,
  onPageFetched?: (input: {
    category: {
      name: string;
      url: string;
      categoryIdPath: string;
    };
    page: number;
    totalPages: number;
    pageProducts: number;
    aggregatedCandidates: number;
  }) => void,
  aggregatedCandidatesReader?: () => number
) {
  const normalizedProducts: SirenaCategoryPageProduct[] = [];
  let page = 1;

  while (true) {
    const products = await fetchSirenaVtexCategoryProducts(
      category.categoryIdPath,
      page,
      pageSize,
      requestConfig
    );

    const pageProducts = products
      .map((product) => normalizeCategoryProduct(normalizeSirenaVtexProduct(product)))
      .filter((product) => product.productId && product.friendlyUrl && product.name);

    normalizedProducts.push(...pageProducts);

    const optimisticTotalPages =
      pageProducts.length < pageSize ? page : page + 1;

    onPageFetched?.({
      category,
      page,
      totalPages: optimisticTotalPages,
      pageProducts: pageProducts.length,
      aggregatedCandidates: aggregatedCandidatesReader?.() ?? normalizedProducts.length,
    });

    if (pageProducts.length < pageSize) {
      break;
    }

    page += 1;
  }

  return normalizedProducts;
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

  await mapWithConcurrency(categories, concurrency, async (category) => {
    const categoryTargets =
      category.subcategories.length > 0
        ? category.subcategories
        : [
            {
              name: category.name,
              url: category.url,
              categoryIdPath: category.categoryIdPath,
            },
          ];

    const categoryBatches = await mapWithConcurrency(
      categoryTargets,
      Math.min(3, concurrency),
      async (targetCategory) => {
        const products = await fetchAllSirenaCategoryProducts(
          targetCategory,
          pageSize,
          requestConfig,
          onPageFetched
            ? (input) =>
                onPageFetched({
                  ...input,
                  category,
                })
            : undefined,
          () => aggregated.size
        );

        mergeCategoryProducts(aggregated, category, targetCategory.url, products);
        return {
          products,
          pages: Math.max(1, Math.ceil(products.length / Math.max(pageSize, 1))),
        };
      }
    );

    const totalProducts = categoryBatches.reduce(
      (sum, batch) => sum + batch.products.length,
      0
    );
    const totalPages = categoryBatches.reduce((sum, batch) => sum + batch.pages, 0);

    onCategoryDiscovered?.({
      category,
      totalProducts,
      totalPages,
    });
  });

  return Array.from(aggregated.values());
}

function mergeCategoryProducts(
  target: Map<string, SirenaCatalogCandidate>,
  category: SirenaTopLevelCategory,
  sourceCategoryUrl: string,
  products: SirenaCategoryPageProduct[]
) {
  for (const product of products) {
    const categoryPath = product.categoryName || category.name;
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
      sourceCategoryUrl,
      topLevelCategorySlug: category.friendlyUrl,
      categoryPath,
      name: product.name,
      imageUrl: product.imageUrl,
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
