export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return "";
}

export function dedupeUrls(
  imageUrls: Array<string | null | undefined>
): string[] {
  const uniqueUrls = new Set<string>();

  for (const imageUrl of imageUrls) {
    const normalizedUrl = normalizeString(imageUrl);
    if (!normalizedUrl) {
      continue;
    }

    uniqueUrls.add(normalizedUrl);
  }

  return Array.from(uniqueUrls);
}

const SIRENA_IMAGE_PREFIX =
  "https://assets-sirenago.s3-us-west-1.amazonaws.com/product/";
const SIRENA_VTEX_IMAGE_PREFIXES = [
  "https://gruporamos.vtexassets.com/arquivos/",
  "https://gruporamos.vteximg.com.br/arquivos/",
] as const;
const BRAVO_IMAGE_PREFIX =
  "https://bravova-resources.superbravo.com.do/images/catalogo/big/";
const NACIONAL_IMAGE_PREFIX = "https://supermercadosnacional.com/";

function getFilenameFromUrl(imageUrl: string) {
  try {
    const parsedUrl = new URL(imageUrl);
    const filename = parsedUrl.pathname.split("/").pop();
    return filename ? filename.toLowerCase() : "";
  } catch {
    const match = imageUrl.match(/\/([^/?#]+)(?:[?#]|$)/);
    return match?.[1]?.toLowerCase() ?? "";
  }
}

export function normalizeNacionalImageUrl(imageUrl: string) {
  return imageUrl.replace(/\?.*$/, "");
}

export function getComparableImageKey(imageUrl: string | null | undefined) {
  const normalizedUrl = normalizeString(imageUrl);
  if (!normalizedUrl) {
    return "";
  }

  if (normalizedUrl.startsWith(SIRENA_IMAGE_PREFIX)) {
    const filename = getFilenameFromUrl(normalizedUrl);
    return filename ? `sirena:${filename}` : normalizedUrl;
  }

  if (
    SIRENA_VTEX_IMAGE_PREFIXES.some((prefix) => normalizedUrl.startsWith(prefix))
  ) {
    try {
      const parsedUrl = new URL(normalizedUrl);
      const vtexMatch = parsedUrl.pathname.match(/\/arquivos\/ids\/(\d+)\/([^/]+)$/i);
      if (vtexMatch) {
        const [, imageId, filename] = vtexMatch;
        return `sirena-vtex:${imageId}:${filename.toLowerCase()}`;
      }
    } catch {
      const vtexMatch = normalizedUrl.match(/\/arquivos\/ids\/(\d+)\/([^/?#]+)(?:[?#]|$)/i);
      if (vtexMatch) {
        const [, imageId, filename] = vtexMatch;
        return `sirena-vtex:${imageId}:${filename.toLowerCase()}`;
      }
    }
  }

  if (normalizedUrl.startsWith(BRAVO_IMAGE_PREFIX)) {
    const filename = getFilenameFromUrl(normalizedUrl);
    return filename ? `bravo:${filename}` : normalizedUrl;
  }

  if (normalizedUrl.startsWith(NACIONAL_IMAGE_PREFIX)) {
    return `nacional:${normalizeNacionalImageUrl(normalizedUrl)}`;
  }

  return normalizedUrl;
}

export function dedupeComparableUrls(
  imageUrls: Array<string | null | undefined>
): string[] {
  const result: string[] = [];
  const seenKeys = new Set<string>();

  for (const imageUrl of imageUrls) {
    const normalizedUrl = normalizeString(imageUrl);
    if (!normalizedUrl) {
      continue;
    }

    const comparableKey = getComparableImageKey(normalizedUrl);
    if (seenKeys.has(comparableKey)) {
      continue;
    }

    seenKeys.add(comparableKey);
    result.push(normalizedUrl);
  }

  return result;
}

export function toAbsoluteUrl(url: string, baseUrl: string): string {
  const normalizedUrl = normalizeString(url);
  if (!normalizedUrl) {
    return "";
  }

  try {
    return new URL(normalizedUrl, baseUrl).toString();
  } catch {
    return normalizedUrl;
  }
}

export function extractTrailingNumericId(url: string): string {
  const normalizedUrl = normalizeString(url);
  if (!normalizedUrl) {
    return "";
  }

  const match = normalizedUrl.match(/\/(\d+)\/?$/);
  return match?.[1] ?? "";
}
