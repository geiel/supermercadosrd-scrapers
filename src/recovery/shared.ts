import * as cheerio from "cheerio";
import {
  NACIONAL_REST_API_URL,
  PLAZA_LAMA_GRAPHQL_URL as CONFIGURED_PLAZA_LAMA_GRAPHQL_URL,
} from "../api-endpoints.js";
import type { RecoveryKey } from "./types.js";

export const RECOVERABLE_SHOP_IDS = [2, 3, 4] as const;
export const PLAZA_LAMA_GRAPHQL_URL = CONFIGURED_PLAZA_LAMA_GRAPHQL_URL;

type SearchCandidate = {
  name: string;
  url: string;
  price: string | null;
  regularPrice: string | null;
};

export function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function extractTrailingDigits(url: string, pattern: RegExp): string | null {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(pattern);
    return match?.[1] ?? null;
  } catch {
    const match = url.match(pattern);
    return match?.[1] ?? null;
  }
}

export function extractNacionalSku(url: string): string | null {
  return extractTrailingDigits(url, /([0-9]{6,})(?:\.html?)?$/i);
}

export function extractJumboUrlTail(url: string): string | null {
  return extractTrailingDigits(url, /-([0-9]{6,})(?:\.html?)?$/i);
}

export function extractPlazaLamaSku(url: string): string | null {
  return extractTrailingDigits(url, /-([0-9]{8,14})\/?$/i);
}

export function buildNacionalLookupUrl(sku: string): string {
  const params = new URLSearchParams({
    "searchCriteria[filter_groups][0][filters][0][field]": "sku",
    "searchCriteria[filter_groups][0][filters][0][value]": sku,
    "searchCriteria[filter_groups][0][filters][0][condition_type]": "in",
    fields: "items[sku,name,custom_attributes[attribute_code,value]],total_count",
  });

  return `${NACIONAL_REST_API_URL}?${params.toString()}`;
}

export function buildNacionalProductUrl(urlPath: string): string {
  const normalized = urlPath.replace(/^\//, "").replace(/\.html?$/i, "");
  return `https://supermercadosnacional.com/${normalized}`;
}

export function buildJumboSearchUrl(query: string): string {
  return `https://jumbo.com.do/catalogsearch/result/?${new URLSearchParams({
    q: query,
  }).toString()}`;
}

export function buildJumboProductUrl(urlKey: string): string {
  const normalized = urlKey.replace(/^\//, "").replace(/\.html?$/i, "");
  return `https://jumbo.com.do/${normalized}`;
}

export function buildPlazaLamaProductUrl(slug: string): string {
  return `https://plazalama.com.do/p/${slug.replace(/^\//, "")}`;
}

export function deriveRecoveryKeyFromRow(input: {
  shopId: number;
  url: string;
  api: string | null;
}): RecoveryKey | null {
  switch (input.shopId) {
    case 2: {
      const sku = extractNacionalSku(input.url);
      return sku
        ? {
            externalIdType: "sku",
            externalId: sku,
            source: "url",
          }
        : null;
    }
    case 3: {
      const urlTail = extractJumboUrlTail(input.url);
      return urlTail
        ? {
            externalIdType: "url_tail",
            externalId: urlTail,
            source: "url",
          }
        : null;
    }
    case 4: {
      const apiSku = input.api?.trim();
      if (apiSku) {
        return {
          externalIdType: "sku",
          externalId: apiSku,
          source: "api",
        };
      }

      const urlSku = extractPlazaLamaSku(input.url);
      return urlSku
        ? {
            externalIdType: "sku",
            externalId: urlSku,
            source: "url",
          }
        : null;
    }
    default:
      return null;
  }
}

function toAbsoluteUrl(url: string | null | undefined, baseUrl: string): string {
  if (!url) {
    return "";
  }

  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function dedupeCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const seen = new Set<string>();
  const deduped: SearchCandidate[] = [];

  for (const candidate of candidates) {
    if (!candidate.url || seen.has(candidate.url)) {
      continue;
    }

    seen.add(candidate.url);
    deduped.push(candidate);
  }

  return deduped;
}

function parseMagentoSearchCandidates(html: string, baseUrl: string): SearchCandidate[] {
  const $ = cheerio.load(html);
  const candidates: SearchCandidate[] = [];

  $(".item.product.product-item").each((_, element) => {
    const item = $(element);
    const url = toAbsoluteUrl(item.find(".product-item-link").attr("href"), baseUrl);

    if (!url) {
      return;
    }

    candidates.push({
      name:
        item.find(".product-item-link").text().trim() ||
        item.find(".product.name.product-item-name").text().trim(),
      url,
      price:
        item.find('span[data-price-type="finalPrice"]').attr("data-price-amount") ??
        null,
      regularPrice:
        item.find('span[data-price-type="oldPrice"]').attr("data-price-amount") ??
        null,
    });
  });

  return dedupeCandidates(candidates);
}

export function parseJumboSearchCandidates(html: string): SearchCandidate[] {
  const $ = cheerio.load(html);
  const tileCandidates: SearchCandidate[] = [];

  $(".product-item-tile__details").each((_, element) => {
    const details = $(element);
    const root = details.closest(".product-item");
    const url = toAbsoluteUrl(
      details.find(".product-item-tile__link").attr("href"),
      "https://jumbo.com.do"
    );

    if (!url) {
      return;
    }

    tileCandidates.push({
      name: details.find(".product-item-tile__name").text().trim(),
      url,
      price:
        root.find('span[data-price-type="finalPrice"]').attr("data-price-amount") ??
        null,
      regularPrice:
        root.find('span[data-price-type="oldPrice"]').attr("data-price-amount") ??
        null,
    });
  });

  if (tileCandidates.length > 0) {
    return dedupeCandidates(tileCandidates);
  }

  return parseMagentoSearchCandidates(html, "https://jumbo.com.do");
}
