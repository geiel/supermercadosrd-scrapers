import * as cheerio from "cheerio";
import { fetchWithRetry } from "../http-client.js";
import { buildNacionalProductUrl } from "../recovery/shared.js";
import type { FetchWithRetryConfig } from "../types.js";
import type { NacionalCatalogProduct, NacionalSitemapEntry } from "./types.js";

const NACIONAL_BASE_URL = "https://supermercadosnacional.com";
const SITEMAP_INDEX_URL = `${NACIONAL_BASE_URL}/media/sitemap/sitemap.xml`;
const PRODUCT_LOOKUP_BATCH_SIZE = 25;
const ALLOWED_NACIONAL_HOSTS = new Set(["supermercadosnacional.com", "www.supermercadosnacional.com"]);

type MagentoProductResponse = {
  items?: Array<{
    sku?: string;
    name?: string;
    custom_attributes?: Array<{
      attribute_code?: string;
      value?: unknown;
    }>;
  }>;
};

function parseXml(xml: string) {
  return cheerio.load(xml, { xmlMode: true });
}

function normalizeCatalogUrl(url: string): string {
  const parsed = new URL(url, NACIONAL_BASE_URL);
  parsed.protocol = "https:";
  parsed.host = "supermercadosnacional.com";
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

function isForeignCatalogHost(url: string) {
  try {
    return !ALLOWED_NACIONAL_HOSTS.has(new URL(url, NACIONAL_BASE_URL).host.toLowerCase());
  } catch {
    return false;
  }
}

function parseDate(value: string): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractTrailingSku(url: string): string {
  const match = url.match(/([0-9]{6,})(?:\.html?)?$/i);
  return match?.[1] ?? "";
}

function parseSitemapIndex(xml: string): string[] {
  const $ = parseXml(xml);
  return $("sitemap")
    .map((_, element) => $(element).find("loc").first().text().trim())
    .get()
    .filter(Boolean);
}

function parseSitemapEntries(xml: string) {
  const $ = parseXml(xml);
  const entries: NacionalSitemapEntry[] = [];
  let foreignHostUrls = 0;

  $("url").each((_, element) => {
    const loc = $(element).find("loc").first().text().trim();
    if (!loc) {
      return;
    }

    if (isForeignCatalogHost(loc)) {
      foreignHostUrls += 1;
    }

    const sku = extractTrailingSku(loc);
    if (!sku) {
      return;
    }

    const lastmod = $(element).find("lastmod").first().text().trim();
    entries.push({
      sku,
      sitemapUrl: loc,
      canonicalUrl: normalizeCatalogUrl(loc),
      lastmod: parseDate(lastmod),
    });
  });

  return {
    entries,
    foreignHostUrls,
  };
}

async function fetchText(url: string, requestConfig?: FetchWithRetryConfig) {
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      },
    },
    requestConfig
  );

  if (!response?.ok) {
    throw new Error(`Request failed for ${url} with status ${response?.status ?? "unknown"}.`);
  }

  return await response.text();
}

function buildLookupUrl(skus: string[]) {
  const params = new URLSearchParams({
    "searchCriteria[filter_groups][0][filters][0][field]": "sku",
    "searchCriteria[filter_groups][0][filters][0][value]": skus.join(","),
    "searchCriteria[filter_groups][0][filters][0][condition_type]": "in",
    fields: "items[sku,name,custom_attributes[attribute_code,value]],total_count",
  });

  return `${NACIONAL_BASE_URL}/rest/default/V1/products?${params.toString()}`;
}

function getAttributeValue(
  item: NonNullable<MagentoProductResponse["items"]>[number],
  code: string
) {
  return item.custom_attributes?.find(
    (attribute) => attribute.attribute_code === code
  )?.value;
}

function normalizeStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number") {
    return `${value}`;
  }

  return "";
}

function normalizeEans(value: unknown): string[] {
  const raw =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.join(";")
        : typeof value === "number"
          ? `${value}`
          : "";

  return Array.from(
    new Set(
      raw
        .split(/[;,|]/)
        .map((item) => item.trim())
        .filter((item) => /^[0-9]{8,14}$/.test(item))
    )
  );
}

function buildImageUrl(value: unknown): string | null {
  const imagePath = normalizeStringValue(value);
  if (!imagePath || imagePath === "no_selection") {
    return null;
  }

  return `${NACIONAL_BASE_URL}/media/catalog/product${imagePath.startsWith("/") ? imagePath : `/${imagePath}`}`;
}

function buildCanonicalUrl(
  sitemapEntry: NacionalSitemapEntry,
  item: NonNullable<MagentoProductResponse["items"]>[number]
): string {
  const urlPath =
    normalizeStringValue(getAttributeValue(item, "url_path")) ||
    normalizeStringValue(getAttributeValue(item, "url_key"));

  if (!urlPath) {
    return sitemapEntry.canonicalUrl;
  }

  return buildNacionalProductUrl(urlPath);
}

function toCatalogProduct(
  sitemapEntry: NacionalSitemapEntry,
  item: NonNullable<MagentoProductResponse["items"]>[number]
): NacionalCatalogProduct | null {
  const sku = normalizeStringValue(item.sku);
  if (!sku) {
    return null;
  }

  const attributes = Object.fromEntries(
    (item.custom_attributes ?? [])
      .map((attribute) => [attribute.attribute_code ?? "", attribute.value])
      .filter(([code]) => code)
  );

  return {
    sku,
    name: normalizeStringValue(item.name),
    canonicalUrl: buildCanonicalUrl(sitemapEntry, item),
    imageUrl: buildImageUrl(getAttributeValue(item, "image")),
    eans: normalizeEans(getAttributeValue(item, "eans")),
    rawAttributes: attributes,
  };
}

export async function fetchNacionalSitemapEntries(
  requestConfig?: FetchWithRetryConfig,
  options?: {
    onProgress?: (event: {
      stage: "fetch_index" | "index_loaded" | "fetch_sitemap" | "sitemap_loaded";
      url?: string;
      current?: number;
      total?: number;
      entries?: number;
      foreignHostUrls?: number;
    }) => void;
  }
): Promise<NacionalSitemapEntry[]> {
  options?.onProgress?.({
    stage: "fetch_index",
    url: SITEMAP_INDEX_URL,
  });
  const indexXml = await fetchText(SITEMAP_INDEX_URL, requestConfig);
  const sitemapUrls = parseSitemapIndex(indexXml);
  options?.onProgress?.({
    stage: "index_loaded",
    url: SITEMAP_INDEX_URL,
    total: sitemapUrls.length,
  });

  const entries: NacionalSitemapEntry[] = [];

  for (let index = 0; index < sitemapUrls.length; index += 1) {
    const url = sitemapUrls[index];
    options?.onProgress?.({
      stage: "fetch_sitemap",
      url,
      current: index + 1,
      total: sitemapUrls.length,
    });

    const xml = await fetchText(url, requestConfig);
    const parsed = parseSitemapEntries(xml);

    options?.onProgress?.({
      stage: "sitemap_loaded",
      url,
      current: index + 1,
      total: sitemapUrls.length,
      entries: parsed.entries.length,
      foreignHostUrls: parsed.foreignHostUrls,
    });

    entries.push(...parsed.entries);
  }

  return entries
    .sort((left, right) => {
      const leftTime = left.lastmod?.getTime() ?? 0;
      const rightTime = right.lastmod?.getTime() ?? 0;
      return rightTime - leftTime;
    });
}

export async function fetchNacionalCatalogProducts(
  entries: NacionalSitemapEntry[],
  requestConfig?: FetchWithRetryConfig,
  batchSize = PRODUCT_LOOKUP_BATCH_SIZE
): Promise<Map<string, NacionalCatalogProduct>> {
  const entriesBySku = new Map(entries.map((entry) => [entry.sku, entry]));
  const skus = Array.from(entriesBySku.keys());
  const products = new Map<string, NacionalCatalogProduct>();

  for (let index = 0; index < skus.length; index += batchSize) {
    const batch = skus.slice(index, index + batchSize);
    const response = await fetchWithRetry(
      buildLookupUrl(batch),
      {
        headers: {
          Accept: "application/json",
          Referer: "https://supermercadosnacional.com/",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        },
      },
      requestConfig
    );

    if (!response?.ok) {
      continue;
    }

    const payload = (await response.json()) as MagentoProductResponse;
    for (const item of payload.items ?? []) {
      const sku = normalizeStringValue(item.sku);
      const entry = entriesBySku.get(sku);
      if (!entry) {
        continue;
      }

      const product = toCatalogProduct(entry, item);
      if (product) {
        products.set(sku, product);
      }
    }
  }

  return products;
}
