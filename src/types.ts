export type ShopId = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type ShopName =
  | "sirena"
  | "nacional"
  | "jumbo"
  | "plaza_lama"
  | "pricesmart"
  | "bravo"
  | "merca_jumbo";

export type ScrapePriceInput = {
  shopId: ShopId;
  url: string;
  api?: string | null;
};

export type FetchWithRetryConfig = {
  maxRetries?: number;
  timeoutMs?: number;
};

export type ScrapePriceSuccess = {
  status: "ok";
  shopId: ShopId;
  shopName: ShopName;
  currentPrice: string;
  regularPrice: string | null;
  locationId?: string | null;
  canonicalUrl?: string;
};

export type ScrapePriceNotFound = {
  status: "not_found";
  shopId: ShopId;
  shopName: ShopName;
  reason: string;
  hide: boolean;
};

export type ScrapePriceError = {
  status: "error";
  shopId: ShopId;
  shopName: ShopName;
  reason: string;
  retryable: boolean;
  hide: boolean;
};

export type ScrapePriceResult =
  | ScrapePriceSuccess
  | ScrapePriceNotFound
  | ScrapePriceError;

export type ScrapeManyOptions = {
  requestConfig?: FetchWithRetryConfig;
  delayMinMs?: number;
  delayMaxMs?: number;
  onProgress?: (event: {
    round: number;
    totalRounds: number;
    processed: number;
    total: number;
  }) => void;
};

export type ScrapeProductImagesInput = {
  shopId: ShopId;
  url: string;
  api?: string | null;
};

export type ScrapeProductImagesSuccess = {
  status: "ok";
  shopId: ShopId;
  shopName: ShopName;
  images: string[];
};

export type ScrapeProductImagesNotFound = {
  status: "not_found";
  shopId: ShopId;
  shopName: ShopName;
  reason: string;
};

export type ScrapeProductImagesError = {
  status: "error";
  shopId: ShopId;
  shopName: ShopName;
  reason: string;
  retryable: boolean;
};

export type ScrapeProductImagesResult =
  | ScrapeProductImagesSuccess
  | ScrapeProductImagesNotFound
  | ScrapeProductImagesError;
