import type {
  FetchWithRetryConfig,
  ScrapeProductImagesInput,
  ScrapeProductImagesResult,
} from "./types.js";
import { scrapeBravoImages } from "./shops/bravo-images.js";
import { scrapeJumboImages } from "./shops/jumbo-images.js";
import { scrapeMercaJumboImages } from "./shops/merca-jumbo-images.js";
import { scrapeNacionalImages } from "./shops/nacional-images.js";
import { scrapePlazaLamaImages } from "./shops/plaza-lama-images.js";
import { scrapePricesmartImages } from "./shops/pricesmart-images.js";
import { scrapeSirenaImages } from "./shops/sirena-images.js";

export async function scrapeProductImages(
  input: ScrapeProductImagesInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapeProductImagesResult> {
  switch (input.shopId) {
    case 1:
      return scrapeSirenaImages(input, requestConfig);
    case 2:
      return scrapeNacionalImages(input, requestConfig);
    case 3:
      return scrapeJumboImages(input, requestConfig);
    case 7:
      return scrapeMercaJumboImages(input, requestConfig);
    case 4:
      return scrapePlazaLamaImages(input, requestConfig);
    case 5:
      return scrapePricesmartImages(input, requestConfig);
    case 6:
      return scrapeBravoImages(input, requestConfig);
  }
}
