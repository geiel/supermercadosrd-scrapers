import { error, notFound, ok, locationInStock, withStock } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";
import {
  extractMercaJumboSkuFromUrl,
  fetchMercaJumboProductBySku,
  type MercaJumboProduct,
} from "./merca-jumbo-shared.js";
import { extractMagentoGraphqlPurchaseTerms } from "./magento-graphql-purchase-terms.js";

const shopId = 7;

export async function scrapeMercaJumboPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const sku = extractMercaJumboSkuFromUrl(input.url);
  const productLookup = await fetchMercaJumboProductBySku(
    {
      sku,
      api: input.api,
    },
    requestConfig
  );

  if (productLookup.status === "not_found") {
    return notFound(shopId, productLookup.reason, true);
  }

  if (productLookup.status === "error") {
    const shouldHide = productLookup.reason === "timeout";

    return error(
      shopId,
      productLookup.reason,
      productLookup.retryable,
      shouldHide
    );
  }

  return toMercaJumboPriceResult(productLookup.product, input);
}

// Shared by the single lookup and the batched price sync.
export function toMercaJumboPriceResult(
  product: MercaJumboProduct,
  input: Pick<ScrapePriceInput, "presentation" | "purchaseMode" | "purchaseUnit">
): ScrapePriceResult {
  if (!product.finalPrice) {
    return error(shopId, "price_not_found", false, false);
  }

  const purchaseTerms = extractMagentoGraphqlPurchaseTerms(
    product.purchaseTermsFields,
    {
      source: "merca_jumbo_graphql",
      productUnit: input,
    }
  );

  return withStock(
    ok(
      shopId,
      product.finalPrice,
      product.regularPrice,
      null,
      undefined,
      undefined,
      purchaseTerms
    ),
    // With branches, out of stock online only when none has it. Without them
    // (they could not be read) nothing changes: the stored flag goes with the
    // stored branches.
    // Listed with no branch rows: the flag and the (empty) branches change
    // together, and only when stock_status says which way; otherwise the
    // stored ones stay, so a product back in stock never keeps a stale flag
    // and an unknown status never empties its branches.
    product.locations === undefined
      ? {}
      : product.locations.length > 0
        ? { locations: product.locations, outOfStockOnline: !product.locations.some(locationInStock) }
        : product.outOfStockOnline === undefined
          ? {}
          : { locations: [], outOfStockOnline: product.outOfStockOnline }
  );
}
