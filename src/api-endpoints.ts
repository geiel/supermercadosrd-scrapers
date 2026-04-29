import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }
}

loadDotEnv();

function requiredApiEndpoint(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value.replace(/\/+$/, "");
}

export const SIRENA_PRODUCT_API_URL_TEMPLATE = requiredApiEndpoint(
  "SIRENA_PRODUCT_API_URL_TEMPLATE"
);
export const SIRENA_PRODUCTS_SEARCH_API_URL = requiredApiEndpoint(
  "SIRENA_PRODUCTS_SEARCH_API_URL"
);
export const SIRENA_CATEGORY_TREE_API_URL_TEMPLATE = requiredApiEndpoint(
  "SIRENA_CATEGORY_TREE_API_URL_TEMPLATE"
);
export const NACIONAL_REST_API_URL = requiredApiEndpoint("NACIONAL_REST_API_URL");
export const PLAZA_LAMA_GRAPHQL_URL = requiredApiEndpoint("PLAZA_LAMA_GRAPHQL_URL");
export const PLAZA_LAMA_DPL_API_KEY = requiredApiEndpoint("PLAZA_LAMA_DPL_API_KEY");
export const PRICESMART_PRODUCT_API_URL = requiredApiEndpoint(
  "PRICESMART_PRODUCT_API_URL"
);
export const PRICESMART_DISCOVERY_API_URL = requiredApiEndpoint(
  "PRICESMART_DISCOVERY_API_URL"
);
