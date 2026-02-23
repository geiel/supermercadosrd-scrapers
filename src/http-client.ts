import type { Browser, Page } from "puppeteer-core";
import type { FetchWithRetryConfig, ShopId } from "./types.js";

function isJumboDebugEnabled(): boolean {
  return (
    process.env.SCRAPER_DEBUG_JUMBO === "1" ||
    process.env.SCRAPER_DEBUG_JUMBO === "true" ||
    process.env.GITHUB_ACTIONS === "true"
  );
}

function logJumboDebug(message: string, context?: Record<string, unknown>): void {
  if (!isJumboDebugEnabled()) {
    return;
  }

  if (context) {
    console.log(`[JUMBO_DEBUG] ${message}`, context);
    return;
  }

  console.log(`[JUMBO_DEBUG] ${message}`);
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.VERCEL;
}

function getChromiumUrl(): string {
  const baseUrl =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    process.env.NEXT_PUBLIC_SITE_URL;

  if (baseUrl) {
    const protocol = baseUrl.startsWith("http") ? "" : "https://";
    return `${protocol}${baseUrl}/chromium-pack.tar`;
  }

  return "https://github.com/nicholaschun/chromium/releases/download/v133.0.0/chromium-v133.0.0-pack.tar";
}

function detectBlockReason(html: string, title: string): string | null {
  const lowerHtml = html.toLowerCase();
  const lowerTitle = title.toLowerCase();

  if (
    lowerHtml.includes("sorry, you have been blocked") ||
    lowerHtml.includes("attention required") ||
    lowerHtml.includes("cf-error-code") ||
    lowerHtml.includes("cloudflare") ||
    lowerTitle.includes("attention required")
  ) {
    return "blocked";
  }

  if (
    lowerTitle.includes("just a moment") ||
    lowerTitle.includes("checking your browser")
  ) {
    return "cloudflare_challenge";
  }

  return null;
}

function normalizeBrowserErrorReason(rawError: unknown): string {
  const message =
    rawError instanceof Error
      ? rawError.message.toLowerCase()
      : String(rawError).toLowerCase();

  if (message.includes("timeout")) {
    return "navigation_timeout";
  }

  if (message.includes("net::err_name_not_resolved")) {
    return "dns_failed";
  }

  if (
    message.includes("net::err_connection") ||
    message.includes("net::err_internet_disconnected") ||
    message.includes("net::err_tunnel_connection_failed")
  ) {
    return "network_error";
  }

  if (message.includes("browser") && message.includes("closed")) {
    return "browser_closed";
  }

  if (message.includes("failed to launch")) {
    return "browser_launch_failed";
  }

  if (message.includes("could not find chrome")) {
    return "browser_not_installed";
  }

  return "request_failed";
}

async function applyStealthSettings(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });
}

async function launchBrowser(): Promise<Browser> {
  if (isProduction()) {
    const puppeteer = await import("puppeteer-core");
    const chromium = await import("@sparticuz/chromium-min");

    const executablePath = await chromium.default.executablePath(getChromiumUrl());

    return await puppeteer.default.launch({
      args: chromium.default.args,
      defaultViewport: { width: 1920, height: 1080 },
      executablePath,
      headless: true,
    });
  }

  const puppeteer = await import("puppeteer");
  return await puppeteer.default.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

export type BrowserFetchResult =
  | { ok: true; html: string }
  | { ok: false; reason: string };

export async function fetchWithBrowserDetailed(
  url: string,
  timeout = 60000
): Promise<BrowserFetchResult> {
  const startedAt = Date.now();
  let browser: Browser | null = null;
  logJumboDebug("browser_fetch_start", {
    url,
    timeout,
    nodeEnv: process.env.NODE_ENV ?? null,
    githubActions: process.env.GITHUB_ACTIONS ?? null,
  });

  try {
    try {
      browser = await launchBrowser();
      logJumboDebug("browser_launch_ok", { url });
    } catch (error) {
      const reason = normalizeBrowserErrorReason(error);
      logJumboDebug("browser_launch_failed", {
        url,
        reason,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
      });
      return { ok: false, reason };
    }
    const page = await browser.newPage();

    await applyStealthSettings(page);
    await page.setViewport({ width: 1920, height: 1080 });

    let statusCode: number | null = null;
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout,
      });
      statusCode = response?.status() ?? null;
      logJumboDebug("goto_completed", { url, statusCode });
    } catch {
      logJumboDebug("goto_failed", { url, reason: "navigation_failed" });
      return { ok: false, reason: "navigation_failed" };
    }

    if (statusCode === 403) {
      logJumboDebug("http_blocked", { url, statusCode });
      return { ok: false, reason: "blocked" };
    }
    if (statusCode === 429) {
      logJumboDebug("http_rate_limited", { url, statusCode });
      return { ok: false, reason: "rate_limited" };
    }
    if (statusCode && statusCode >= 500) {
      logJumboDebug("http_server_error", { url, statusCode });
      return { ok: false, reason: `http_${statusCode}` };
    }

    try {
      await page.waitForFunction(
        () => {
          const title = document.title.toLowerCase();
          const isCloudflare =
            title.includes("just a moment") ||
            title.includes("attention required") ||
            title.includes("checking your browser");

          return !isCloudflare;
        },
        { timeout: 15000 }
      );
    } catch {
      // We still inspect the DOM after timeout to report whether this is a block/challenge.
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const [html, title] = await Promise.all([page.content(), page.title()]);
    logJumboDebug("page_loaded", {
      url,
      statusCode,
      htmlLength: html.length,
      title,
      elapsedMs: Date.now() - startedAt,
    });
    const blockReason = detectBlockReason(html, title);
    if (blockReason) {
      logJumboDebug("block_reason_detected", {
        url,
        statusCode,
        blockReason,
        title,
      });
      return { ok: false, reason: blockReason };
    }

    if (!html.trim()) {
      logJumboDebug("empty_html", { url, statusCode });
      return { ok: false, reason: "empty_html" };
    }

    logJumboDebug("browser_fetch_ok", {
      url,
      statusCode,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: true, html };
  } catch (error) {
    const reason = normalizeBrowserErrorReason(error);
    logJumboDebug("browser_fetch_exception", {
      url,
      reason,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: false, reason };
  } finally {
    if (browser) {
      await browser.close();
      logJumboDebug("browser_closed", { url });
    }
  }
}

export async function fetchWithBrowser(
  url: string,
  timeout = 60000
): Promise<string | null> {
  const result = await fetchWithBrowserDetailed(url, timeout);
  return result.ok ? result.html : null;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
];

export function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getCommonChromeHeaders(userAgent: string) {
  return {
    "User-Agent": userAgent,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="143", "Not A(Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  };
}

export function getNacionalHeaders(): Record<string, string> {
  const userAgent = getRandomUserAgent();

  return {
    ...getCommonChromeHeaders(userAgent),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    Referer: "https://supermercadosnacional.com/",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    priority: "u=0, i",
  };
}

export function getJumboHeaders(): Record<string, string> {
  const userAgent = getRandomUserAgent();

  return {
    ...getCommonChromeHeaders(userAgent),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    Referer: "https://jumbo.com.do/",
    "Cache-Control": "max-age=0",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    priority: "u=0, i",
  };
}

export function getSirenaHeaders(): Record<string, string> {
  const userAgent = getRandomUserAgent();

  return {
    ...getCommonChromeHeaders(userAgent),
    Accept: "application/json",
    Origin: "https://sirena.do",
    Referer: "https://sirena.do/",
    client: "MWZiZWNmNzM4YWU5ODkwMGI5MjQ4ZjI1ODNhZWZlNjYwNGE2MmEwZg==",
    source: "c3RvcmVmcm9udA==",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    priority: "u=1, i",
  };
}

export function getPlazaLamaHeaders(): Record<string, string> {
  const userAgent = getRandomUserAgent();

  return {
    ...getCommonChromeHeaders(userAgent),
    Accept: "*/*",
    "Content-Type": "application/json",
    Origin: "https://plazalama.com.do",
    Referer: "https://plazalama.com.do/",
    "apollographql-client-name": "Ecommerce Moira client",
    "apollographql-client-version": "0.18.386",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    priority: "u=1, i",
  };
}

export function getPricesmartHeaders(): Record<string, string> {
  const userAgent = getRandomUserAgent();

  return {
    ...getCommonChromeHeaders(userAgent),
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: "https://www.pricesmart.com",
    Referer: "https://www.pricesmart.com/es-do/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    priority: "u=1, i",
  };
}

export function getBravoHeaders(): Record<string, string> {
  return {
    Host: "bravova-api.superbravo.com.do",
    "X-Auth-Token":
      "dDfy25KA4AbcAIbTGrWHimB1eaiJnCAHqBO1cQlb113QtVsKOHlobtCzUh0FTdOPkLTSEl7Wn17TW0K2jIvoMybcp4zp7beQqdX1zxKqKb6yfZnKlF3hTDaIVZbi1OIB",
    Accept: "*/*",
    "User-Agent": "Domicilio/122130 CFNetwork/3826.500.131 Darwin/24.5.0",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
  };
}

export function getHeadersByShopId(shopId: ShopId): Record<string, string> {
  switch (shopId) {
    case 1:
      return getSirenaHeaders();
    case 2:
      return getNacionalHeaders();
    case 3:
      return getJumboHeaders();
    case 4:
      return getPlazaLamaHeaders();
    case 5:
      return getPricesmartHeaders();
    case 6:
      return getBravoHeaders();
    default:
      return getNacionalHeaders();
  }
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: FetchWithRetryConfig = {}
): Promise<Response | null> {
  const { maxRetries = 3, timeoutMs = 10000 } = config;
  const attempts = Math.max(1, maxRetries);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 429 || response.status === 503) {
        if (attempt === attempts - 1) {
          return null;
        }

        const waitTime = Math.pow(2, attempt) * 5000 + Math.random() * 2000;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      return response;
    } catch {
      if (attempt === attempts - 1) {
        return null;
      }

      const waitTime = Math.pow(2, attempt) * 2000 + Math.random() * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  return null;
}
