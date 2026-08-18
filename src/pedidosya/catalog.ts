import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import puppeteer, {
  type Browser,
  type HTTPResponse,
  type Page,
} from "puppeteer";
import { randomDelay } from "../utils.js";

export const DEFAULT_PEDIDOSYA_MENU_URL =
  "https://www.pedidosya.com.do/restaurantes/santo-domingo-d.n./pedidosya-market-27-de-febrero-1686b9bb-4572-4a11-b11a-8f790c95c88e-menu";
export const DEFAULT_PEDIDOSYA_VENDOR_ID = "180650";

type JsonRecord = Record<string, unknown>;

export type PedidosYaCategory = {
  id: string;
  name: string | null;
};

export type PedidosYaProduct = {
  externalId: string;
  name: string;
  description: string | null;
  currentPrice: number | null;
  regularPrice: number | null;
  pricePerMeasurementUnit: unknown;
  imageUrl: string | null;
  gtin: string | null;
  integrationCode: string | null;
  legacyId: string | null;
  maxQuantity: number | null;
  requiresAgeCheck: boolean;
  categoryIds: string[];
  categoryNames: string[];
  campaigns: unknown[];
  stock: unknown;
  tags: unknown[];
  raw: JsonRecord;
};

export type PedidosYaApiExchange = {
  kind: "categories" | "products";
  url: string;
  status: number;
  categoryId: string | null;
  page: number | null;
  productCount: number | null;
  source: "website" | "pagination";
};

export type PedidosYaRunReport = {
  status: "ok" | "blocked" | "error";
  reason: string | null;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  menuUrl: string;
  vendorId: string;
  pageSize: number;
  maxPagesPerCategory: number;
  navigationStatus: number | null;
  finalUrl: string | null;
  pageTitle: string | null;
  categoriesFound: number;
  productsFound: number;
  apiExchanges: PedidosYaApiExchange[];
  githubActions: boolean;
  runnerOs: string | null;
};

export type PedidosYaCatalogResult = {
  report: PedidosYaRunReport;
  categories: PedidosYaCategory[];
  products: PedidosYaProduct[];
  rawCategories: unknown;
  diagnosticHtml: string | null;
  screenshotPath: string | null;
};

export type ScrapePedidosYaCatalogOptions = {
  menuUrl?: string;
  vendorId?: string;
  pageSize?: number;
  maxPagesPerCategory?: number;
  timeoutMs?: number;
  settleMs?: number;
  delayMinMs?: number;
  delayMaxMs?: number;
  diagnosticDirectory?: string;
  extraHeaders?: Record<string, string>;
  proxyServer?: string | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
};

type ApiBody = {
  status: number;
  url: string;
  payload: unknown;
  text: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : null;
}

function getFirstNumber(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const parsed = normalizeNumber(record[key]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function getCategoryChildren(category: JsonRecord) {
  for (const key of ["children", "categories", "subcategories", "items"]) {
    const value = category[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function getCategoriesRoot(payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (Array.isArray(payload.categories)) {
    return payload.categories;
  }

  if (isRecord(payload.data) && Array.isArray(payload.data.categories)) {
    return payload.data.categories;
  }

  return [];
}

export function extractPedidosYaCategories(payload: unknown) {
  const categories = new Map<string, PedidosYaCategory>();

  function visit(value: unknown) {
    if (!isRecord(value)) {
      return;
    }

    const id = normalizeString(
      value.global_id ?? value.globalId ?? value.id ?? value.uuid
    );
    const name = normalizeString(value.name ?? value.title ?? value.label);

    if (id) {
      categories.set(id, { id, name });
    }

    for (const child of getCategoryChildren(value)) {
      visit(child);
    }
  }

  for (const category of getCategoriesRoot(payload)) {
    visit(category);
  }

  return [...categories.values()];
}

function extractProductRecords(payload: unknown): JsonRecord[] {
  if (!isRecord(payload)) {
    return [];
  }

  const candidates = [
    payload.products,
    payload.items,
    isRecord(payload.data) ? payload.data.products : null,
    isRecord(payload.data) ? payload.data.items : null,
  ];

  const products = candidates.find(Array.isArray);
  return Array.isArray(products) ? products.filter(isRecord) : [];
}

function extractTotalProducts(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }

  const data = isRecord(payload.data) ? payload.data : null;
  return (
    getFirstNumber(payload, ["totalProducts", "total", "count"]) ??
    (data
      ? getFirstNumber(data, ["totalProducts", "total", "count"])
      : null)
  );
}

function getRegularPrice(pricing: JsonRecord, currentPrice: number | null) {
  const regularPrice = getFirstNumber(pricing, [
    "regularPrice",
    "originalPrice",
    "beforePrice",
    "basePrice",
    "listPrice",
  ]);

  if (
    regularPrice === null ||
    currentPrice === null ||
    regularPrice === currentPrice
  ) {
    return null;
  }

  return regularPrice;
}

export function normalizePedidosYaProduct(
  raw: JsonRecord,
  category: PedidosYaCategory
): PedidosYaProduct | null {
  const externalId = normalizeString(
    raw.id ?? raw.global_id ?? raw.globalId ?? raw.productId ?? raw.uuid
  );
  const name = normalizeString(raw.name ?? raw.title);

  if (!externalId || !name) {
    return null;
  }

  const pricing = isRecord(raw.pricing) ? raw.pricing : {};
  const currentPrice =
    getFirstNumber(pricing, ["price", "currentPrice", "salePrice"]) ??
    getFirstNumber(raw, ["price", "currentPrice", "salePrice"]);
  const absoluteImages = Array.isArray(raw.absoluteImages)
    ? raw.absoluteImages
    : [];
  const campaigns = Array.isArray(raw.campaigns) ? raw.campaigns : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : [];

  return {
    externalId,
    name,
    description: normalizeString(raw.description),
    currentPrice,
    regularPrice: getRegularPrice(pricing, currentPrice),
    pricePerMeasurementUnit:
      pricing.pricePerMeasurementUnit ?? raw.pricePerMeasurementUnit ?? null,
    imageUrl:
      normalizeString(absoluteImages[0]) ??
      normalizeString(raw.image ?? raw.imageUrl),
    gtin: normalizeString(raw.gtin),
    integrationCode: normalizeString(raw.integrationCode),
    legacyId: normalizeString(raw.legacyId),
    maxQuantity: normalizeNumber(raw.maxQuantity),
    requiresAgeCheck: raw.requiresAgeCheck === true,
    categoryIds: [category.id],
    categoryNames: category.name ? [category.name] : [],
    campaigns,
    stock: raw.stock ?? null,
    tags,
    raw,
  };
}

function mergeProduct(
  products: Map<string, PedidosYaProduct>,
  product: PedidosYaProduct
) {
  const existing = products.get(product.externalId);
  if (!existing) {
    products.set(product.externalId, product);
    return;
  }

  for (const categoryId of product.categoryIds) {
    if (!existing.categoryIds.includes(categoryId)) {
      existing.categoryIds.push(categoryId);
    }
  }

  for (const categoryName of product.categoryNames) {
    if (!existing.categoryNames.includes(categoryName)) {
      existing.categoryNames.push(categoryName);
    }
  }
}

function parseApiUrl(url: string, vendorId: string) {
  try {
    const parsed = new URL(url);
    const categoriesPath = `/groceries/web/v1/vendors/${vendorId}/categories`;
    const productsPath = `/groceries/web/v1/vendors/${vendorId}/products`;

    if (parsed.pathname === categoriesPath) {
      return {
        kind: "categories" as const,
        categoryId: null,
        page: null,
      };
    }

    if (parsed.pathname === productsPath) {
      return {
        kind: "products" as const,
        categoryId: parsed.searchParams.get("categoryId"),
        page: normalizeNumber(parsed.searchParams.get("page")),
      };
    }
  } catch {
    return null;
  }

  return null;
}

function assertAllowedMenuUrl(rawUrl: string) {
  const parsed = new URL(rawUrl);
  if (
    parsed.protocol !== "https:" ||
    (parsed.hostname !== "pedidosya.com.do" &&
      parsed.hostname !== "www.pedidosya.com.do")
  ) {
    throw new Error("menu_url_must_use_pedidosya_com_do_https");
  }

  return parsed;
}

function detectBlockReason(status: number | null, title: string, html: string) {
  if (status === 403) {
    return "http_403";
  }

  if (status === 429) {
    return "http_429";
  }

  const text = `${title}\n${html}`.toLowerCase();
  if (
    text.includes("acceso ha sido denegado") ||
    text.includes("access denied") ||
    text.includes("px-captcha") ||
    text.includes("perimeterx")
  ) {
    return "access_denied";
  }

  if (
    text.includes("just a moment") ||
    text.includes("checking your browser") ||
    text.includes("cf-chl-")
  ) {
    return "cloudflare_challenge";
  }

  return null;
}

async function readResponse(response: HTTPResponse): Promise<ApiBody> {
  const text = await response.text();
  let payload: unknown = null;

  try {
    payload = JSON.parse(text);
  } catch {
    // The caller records the HTTP exchange and decides whether an empty payload
    // is terminal. Keeping the body makes the run artifact useful for diagnosis.
  }

  return {
    status: response.status(),
    url: response.url(),
    payload,
    text,
  };
}

async function fetchApiPage(page: Page, url: string): Promise<ApiBody> {
  const result = await page.evaluate(async (requestUrl) => {
    const response = await fetch(requestUrl, {
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });

    return {
      status: response.status,
      url: response.url,
      text: await response.text(),
    };
  }, url);
  let payload: unknown = null;

  try {
    payload = JSON.parse(result.text);
  } catch {
    // Returned below so the diagnostic report can describe the failing page.
  }

  return { ...result, payload };
}

async function captureDiagnostics(
  page: Page,
  directory: string | undefined
) {
  const html = (await page.content()).slice(0, 750_000);
  if (!directory) {
    return { html, screenshotPath: null };
  }

  await mkdir(directory, { recursive: true });
  const screenshotPath = join(directory, "pedidosya-page.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return { html, screenshotPath };
}

async function configureBrowserIdentity(page: Page, browser: Browser) {
  const browserUserAgent = await browser.userAgent();
  const userAgent = browserUserAgent.replace("HeadlessChrome", "Chrome");

  await page.setUserAgent(userAgent);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", {
      get: () => ["es-DO", "es", "en"],
    });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
  });
}

function buildEmptyReport(
  options: Required<
    Pick<
      ScrapePedidosYaCatalogOptions,
      "menuUrl" | "vendorId" | "pageSize" | "maxPagesPerCategory"
    >
  >,
  startedAt: Date
): PedidosYaRunReport {
  return {
    status: "error",
    reason: null,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    elapsedMs: 0,
    menuUrl: options.menuUrl,
    vendorId: options.vendorId,
    pageSize: options.pageSize,
    maxPagesPerCategory: options.maxPagesPerCategory,
    navigationStatus: null,
    finalUrl: null,
    pageTitle: null,
    categoriesFound: 0,
    productsFound: 0,
    apiExchanges: [],
    githubActions: process.env.GITHUB_ACTIONS === "true",
    runnerOs: process.env.RUNNER_OS ?? null,
  };
}

function finishReport(report: PedidosYaRunReport, startedAt: Date) {
  const finishedAt = new Date();
  report.finishedAt = finishedAt.toISOString();
  report.elapsedMs = finishedAt.getTime() - startedAt.getTime();
}

async function waitForResponseOrTimeout(
  responsePromise: Promise<HTTPResponse>,
  timeoutMs: number
) {
  let timeout: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      responsePromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("categories_request_timeout")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function scrapePedidosYaCatalog(
  input: ScrapePedidosYaCatalogOptions = {}
): Promise<PedidosYaCatalogResult> {
  const startedAt = new Date();
  const menuUrl = input.menuUrl ?? DEFAULT_PEDIDOSYA_MENU_URL;
  const vendorId = input.vendorId ?? DEFAULT_PEDIDOSYA_VENDOR_ID;
  const pageSize = input.pageSize ?? 20;
  const maxPagesPerCategory = input.maxPagesPerCategory ?? 50;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const settleMs = input.settleMs ?? 6_000;
  const delayMinMs = input.delayMinMs ?? 150;
  const delayMaxMs = input.delayMaxMs ?? 350;
  const report = buildEmptyReport(
    { menuUrl, vendorId, pageSize, maxPagesPerCategory },
    startedAt
  );
  const result: PedidosYaCatalogResult = {
    report,
    categories: [],
    products: [],
    rawCategories: null,
    diagnosticHtml: null,
    screenshotPath: null,
  };
  let browser: Browser | null = null;

  try {
    const parsedMenuUrl = assertAllowedMenuUrl(menuUrl);
    if (!/^\d+$/.test(vendorId)) {
      throw new Error("vendor_id_must_be_numeric");
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error("page_size_must_be_between_1_and_100");
    }
    if (
      !Number.isInteger(maxPagesPerCategory) ||
      maxPagesPerCategory < 1 ||
      maxPagesPerCategory > 250
    ) {
      throw new Error("max_pages_must_be_between_1_and_250");
    }

    const launchArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--lang=es-DO",
      "--window-size=1440,1200",
    ];
    if (input.proxyServer) {
      launchArgs.push(`--proxy-server=${input.proxyServer}`);
    }

    const executablePath =
      process.env.PEDIDOSYA_CHROME_EXECUTABLE?.trim() || undefined;
    const headless = process.env.PEDIDOSYA_HEADLESS !== "false";
    browser = await puppeteer.launch({
      headless,
      args: launchArgs,
      executablePath,
      ignoreDefaultArgs: ["--enable-automation"],
    });
    const page = await browser.newPage();
    await configureBrowserIdentity(page, browser);
    await page.setViewport({ width: 1440, height: 1200 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "es-DO,es;q=0.9,en;q=0.7",
    });
    if (input.extraHeaders && Object.keys(input.extraHeaders).length > 0) {
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        let isPedidosYaRequest = false;

        try {
          const hostname = new URL(request.url()).hostname;
          isPedidosYaRequest =
            hostname === "pedidosya.com.do" ||
            hostname === "www.pedidosya.com.do";
        } catch {
          // Invalid URLs are continued unchanged.
        }

        void request
          .continue(
            isPedidosYaRequest
              ? {
                  headers: {
                    ...request.headers(),
                    ...input.extraHeaders,
                  },
                }
              : undefined
          )
          .catch(() => undefined);
      });
    }
    if (input.proxyUsername) {
      await page.authenticate({
        username: input.proxyUsername,
        password: input.proxyPassword ?? "",
      });
    }

    const observedProductResponses = new Map<string, HTTPResponse>();
    const observedCategoryIds = new Set<string>();
    let resolveCategoriesResponse: ((response: HTTPResponse) => void) | null =
      null;
    const categoriesResponsePromise = new Promise<HTTPResponse>((resolve) => {
      resolveCategoriesResponse = resolve;
    });

    page.on("response", (response) => {
      const parsed = parseApiUrl(response.url(), vendorId);
      if (!parsed) {
        return;
      }

      if (parsed.kind === "categories") {
        resolveCategoriesResponse?.(response);
        resolveCategoriesResponse = null;
        return;
      }

      if (!parsed.categoryId) {
        return;
      }

      observedCategoryIds.add(parsed.categoryId);
      const pageNumber = parsed.page ?? 0;
      const key = `${parsed.categoryId}:${pageNumber}`;
      if (!observedProductResponses.has(key)) {
        observedProductResponses.set(key, response);
      }
    });

    const navigationResponse = await page.goto(parsedMenuUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    report.navigationStatus = navigationResponse?.status() ?? null;
    report.finalUrl = page.url();
    report.pageTitle = await page.title();

    const initialHtml = await page.content();
    const initialBlockReason = detectBlockReason(
      report.navigationStatus,
      report.pageTitle,
      initialHtml
    );
    if (initialBlockReason) {
      report.status = "blocked";
      report.reason = initialBlockReason;
      const diagnostics = await captureDiagnostics(
        page,
        input.diagnosticDirectory
      );
      result.diagnosticHtml = diagnostics.html;
      result.screenshotPath = diagnostics.screenshotPath;
      finishReport(report, startedAt);
      return result;
    }

    const categoriesResponse = await waitForResponseOrTimeout(
      categoriesResponsePromise,
      timeoutMs
    );
    const categoriesBody = await readResponse(categoriesResponse);
    report.apiExchanges.push({
      kind: "categories",
      url: categoriesBody.url,
      status: categoriesBody.status,
      categoryId: null,
      page: null,
      productCount: null,
      source: "website",
    });

    if (categoriesBody.status === 403 || categoriesBody.status === 429) {
      report.status = "blocked";
      report.reason = `categories_http_${categoriesBody.status}`;
      const diagnostics = await captureDiagnostics(
        page,
        input.diagnosticDirectory
      );
      result.diagnosticHtml = diagnostics.html;
      result.screenshotPath = diagnostics.screenshotPath;
      finishReport(report, startedAt);
      return result;
    }
    if (!categoriesBody.payload) {
      throw new Error("categories_response_was_not_json");
    }

    result.rawCategories = categoriesBody.payload;
    result.categories = extractPedidosYaCategories(categoriesBody.payload);
    await new Promise((resolve) => setTimeout(resolve, settleMs));

    const categoriesById = new Map(
      result.categories.map((category) => [category.id, category] as const)
    );
    const categoryIds =
      observedCategoryIds.size > 0
        ? [...observedCategoryIds]
        : result.categories.map((category) => category.id);
    const products = new Map<string, PedidosYaProduct>();

    for (const categoryId of categoryIds) {
      const category = categoriesById.get(categoryId) ?? {
        id: categoryId,
        name: null,
      };
      let productsReadForCategory = 0;
      let previousPageSignature: string | null = null;

      for (let pageNumber = 0; pageNumber < maxPagesPerCategory; pageNumber += 1) {
        const apiUrl = new URL(
          `/groceries/web/v1/vendors/${vendorId}/products`,
          parsedMenuUrl.origin
        );
        apiUrl.searchParams.set("categoryId", categoryId);
        apiUrl.searchParams.set("limit", String(pageSize));
        apiUrl.searchParams.set("page", String(pageNumber));

        let body: ApiBody;
        const observedResponse = observedProductResponses.get(
          `${categoryId}:${pageNumber}`
        );
        if (observedResponse) {
          try {
            body = await readResponse(observedResponse);
          } catch {
            body = await fetchApiPage(page, apiUrl.href);
          }
        } else {
          if (pageNumber > 0 || productsReadForCategory > 0) {
            await randomDelay(delayMinMs, delayMaxMs);
          }
          body = await fetchApiPage(page, apiUrl.href);
        }

        const pageProducts = extractProductRecords(body.payload);
        report.apiExchanges.push({
          kind: "products",
          url: body.url,
          status: body.status,
          categoryId,
          page: pageNumber,
          productCount: pageProducts.length,
          source: observedResponse ? "website" : "pagination",
        });

        if (body.status === 403 || body.status === 429) {
          report.status = "blocked";
          report.reason = `products_http_${body.status}`;
          const diagnostics = await captureDiagnostics(
            page,
            input.diagnosticDirectory
          );
          result.diagnosticHtml = diagnostics.html;
          result.screenshotPath = diagnostics.screenshotPath;
          result.products = [...products.values()];
          report.categoriesFound = categoryIds.length;
          report.productsFound = result.products.length;
          finishReport(report, startedAt);
          return result;
        }
        if (!body.payload) {
          throw new Error(
            `products_response_was_not_json:${categoryId}:${pageNumber}`
          );
        }

        const signature = pageProducts
          .map((product) => normalizeString(product.id) ?? "")
          .join(",");
        if (signature && signature === previousPageSignature) {
          break;
        }
        previousPageSignature = signature || null;

        for (const rawProduct of pageProducts) {
          const normalized = normalizePedidosYaProduct(rawProduct, category);
          if (normalized) {
            mergeProduct(products, normalized);
          }
        }

        productsReadForCategory += pageProducts.length;
        const totalProducts = extractTotalProducts(body.payload);
        if (
          pageProducts.length === 0 ||
          pageProducts.length < pageSize ||
          (totalProducts !== null && productsReadForCategory >= totalProducts)
        ) {
          break;
        }
      }
    }

    result.products = [...products.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "es")
    );
    report.status = result.products.length > 0 ? "ok" : "error";
    report.reason = result.products.length > 0 ? null : "no_products_found";
    report.categoriesFound = categoryIds.length;
    report.productsFound = result.products.length;
    finishReport(report, startedAt);
    return result;
  } catch (error) {
    report.status = "error";
    report.reason =
      error instanceof Error ? error.message : String(error ?? "unknown_error");
    finishReport(report, startedAt);
    return result;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
