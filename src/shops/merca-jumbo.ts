import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";
import {
  extractMercaJumboSkuFromUrl,
  fetchMercaJumboProductBySku,
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

  if (!productLookup.product.finalPrice) {
    return error(shopId, "price_not_found", false, false);
  }

  const purchaseTerms = extractMagentoGraphqlPurchaseTerms(
    productLookup.product.purchaseTermsFields,
    {
      source: "merca_jumbo_graphql",
      productUnit: input,
    }
  );

  return ok(
    shopId,
    productLookup.product.finalPrice,
    productLookup.product.regularPrice,
    null,
    undefined,
    undefined,
    purchaseTerms
  );
}
