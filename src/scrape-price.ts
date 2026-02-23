import {
  scrapeBravoPrice,
  scrapeJumboPrice,
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
      return scrapeJumboPrice(input);
    case 4:
      return scrapePlazaLamaPrice(input, requestConfig);
    case 5:
      return scrapePricesmartPrice(input, requestConfig);
    case 6:
      return scrapeBravoPrice(input, requestConfig);
  }
}
