export { scrapePrice } from "./scrape-price.js";
export { scrapeProductImages } from "./scrape-product-images.js";
export { scrapeManyRoundRobin } from "./scrape-many.js";
export {
  buildPurchaseTerms,
  inferModeFromUnit,
  normalizePurchaseUnit,
} from "./purchase-terms.js";

export {
  fetchWithRetry,
  fetchWithBrowser,
  getHeadersByShopId,
  getNacionalHeaders,
  getJumboHeaders,
  getSirenaHeaders,
  getPlazaLamaHeaders,
  getPricesmartHeaders,
  getBravoHeaders,
  getCarrefourHeaders,
} from "./http-client.js";

export type {
  FetchWithRetryConfig,
  ScrapeManyOptions,
  ScrapeProductImagesError,
  ScrapeProductImagesInput,
  ScrapeProductImagesNotFound,
  ScrapeProductImagesResult,
  ScrapeProductImagesSuccess,
  ScrapePriceError,
  ScrapePriceInput,
  ScrapePriceNotFound,
  ScrapePriceResult,
  ScrapePriceSuccess,
  ShopId,
  ShopName,
} from "./types.js";
export type { PurchaseMode, PurchaseTerms } from "./purchase-terms.js";

export {
  scrapeSirenaPrice,
  scrapeNacionalPrice,
  scrapeJumboPrice,
  scrapeMercaJumboPrice,
  scrapePlazaLamaPrice,
  scrapePricesmartPrice,
  scrapeBravoPrice,
  scrapeCarrefourPrice,
} from "./shops/index.js";
