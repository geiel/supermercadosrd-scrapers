export type ShopId = 1 | 2 | 3 | 4 | 5 | 6;

export type ShopName =
  | "sirena"
  | "nacional"
  | "jumbo"
  | "plaza_lama"
  | "pricesmart"
  | "bravo";

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
