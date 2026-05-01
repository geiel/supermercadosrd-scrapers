import {
  scrapeBravoPrice,
  scrapeJumboPrice,
  scrapeMercaJumboPrice,
  scrapeGarridoPrice,
  scrapeNacionalPrice,
  scrapePlazaLamaPrice,
  scrapePricesmartPrice,
  scrapeSirenaPrice,
} from "./shops/index.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "./types.js";

export async function scrapePrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  switch (input.shopId) {
    case 1:
      return scrapeSirenaPrice(input, requestConfig);
    case 2:
      return scrapeNacionalPrice(input, requestConfig);
    case 3:
      return scrapeJumboPrice(input, requestConfig);
    case 7:
      return scrapeMercaJumboPrice(input, requestConfig);
    case 4:
      return scrapePlazaLamaPrice(input, requestConfig);
    case 5:
      return scrapePricesmartPrice(input, requestConfig);
    case 6:
      return scrapeBravoPrice(input, requestConfig);
    case 8:
      return scrapeGarridoPrice(input, requestConfig);
  }
}
