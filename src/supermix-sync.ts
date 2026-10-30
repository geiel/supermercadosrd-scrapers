import { error } from "./result.js";
import {
  fetchSupermixCatalogPage,
  fetchSupermixProduct,
  SUPERMIX_SHOP_ID,
  toSupermixPriceResult,
  type SupermixApiConfig,
} from "./shops/supermix.js";
import type { ScrapePriceResult } from "./types.js";

type BeforeRequest = () => Promise<void>;

/** A failed traversal must never reach the job's database writes. */
export async function loadSupermixCatalog(
  config: SupermixApiConfig,
  beforeRequest: BeforeRequest,
  { minProducts = 5000, maxPages = 1000 } = {}
) {
  const productsById = new Map<string, unknown>();
  const productsBySlug = new Map<string, unknown>();

  for (let page = 1; page <= maxPages; page += 1) {
    await beforeRequest();
    const fetched = await fetchSupermixCatalogPage(page, config);
    if (!fetched.ok) {
      throw new Error(`Supermix catalog_page_${page}:${fetched.reason}`);
    }

    // Supermix caps pagination.total_pages at 100 even with >20k products.
    // Keep going until an actual empty page, including after a short page.
    if (fetched.products.length === 0) {
      if (productsById.size < minProducts) {
        throw new Error(`Supermix catalog_too_small:${productsById.size}`);
      }
      return { productsById, productsBySlug, pages: page };
    }

    for (const product of fetched.products) {
      const item = product as { id?: unknown; slug?: unknown } | null;
      if (!Number.isSafeInteger(item?.id) || typeof item?.slug !== "string" || !item.slug) {
        throw new Error(`Supermix catalog_page_${page}:invalid_product_reference`);
      }
      const id = String(item.id);
      if (productsById.has(id)) {
        throw new Error(`Supermix catalog_page_${page}:duplicate_product_id:${id}`);
      }
      productsById.set(id, product);
      productsBySlug.set(item.slug.toLowerCase(), product);
    }
  }

  throw new Error(`Supermix catalog_page_limit_reached:${maxPages}`);
}

/** Always confirm linked variants in detail, even when absent from the listing. */
export async function loadSupermixVariants(
  linkedVariants: Map<string, Set<string>>,
  config: SupermixApiConfig,
  beforeRequest: BeforeRequest
) {
  const results = new Map<string, ScrapePriceResult>();
  const requestFailures: string[] = [];
  for (const [id, variantIds] of linkedVariants) {
    await beforeRequest();
    const fetched = await fetchSupermixProduct(id, config);
    if (!fetched.ok) {
      requestFailures.push(`${id}:${fetched.reason}`);
    }
    for (const variantId of variantIds) {
      results.set(
        `${id}:${variantId}`,
        fetched.ok
          ? toSupermixPriceResult(fetched.product, variantId)
          : error(SUPERMIX_SHOP_ID, fetched.reason, true, false)
      );
    }
  }
  return { results, requestFailures, requests: linkedVariants.size };
}
