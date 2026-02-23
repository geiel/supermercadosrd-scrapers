export { scrapePrice } from "./scrape-price.js";
export { scrapeManyRoundRobin } from "./scrape-many.js";

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
} from "./http-client.js";

export type {
  FetchWithRetryConfig,
  ScrapeManyOptions,
  ScrapePriceError,
  ScrapePriceInput,
  ScrapePriceNotFound,
  ScrapePriceResult,
  ScrapePriceSuccess,
  ShopId,
  ShopName,
} from "./types.js";

export {
  scrapeSirenaPrice,
  scrapeNacionalPrice,
  scrapeJumboPrice,
  scrapePlazaLamaPrice,
  scrapePricesmartPrice,
  scrapeBravoPrice,
} from "./shops/index.js";
