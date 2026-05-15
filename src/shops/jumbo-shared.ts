import {
  dedupeComparableUrls,
  normalizeNacionalImageUrl,
  normalizeString,
} from "../image-utils.js";

export const JUMBO_GRAPHQL_URL = "https://jumbo.com.do/graphql";

const JUMBO_STORE_CODE_ENV = "JUMBO_STORE_CODE";
const DEFAULT_JUMBO_STORE_CODE = "jumbo";

export const jumboImageGraphqlFields = `
      image {
        url
      }
      small_image {
        url
      }
      thumbnail {
        url
      }
      media_gallery {
        url
        disabled
      }`;

type JumboImageField = {
  url?: string | null;
};

export type JumboProductImageFields = {
  image?: JumboImageField | null;
  small_image?: JumboImageField | null;
  thumbnail?: JumboImageField | null;
  media_gallery?:
    | Array<{
        url?: string | null;
        disabled?: boolean | null;
      }>
    | null;
};

export function resolveJumboStoreCode() {
  const storeCode = process.env[JUMBO_STORE_CODE_ENV]?.trim();
  return storeCode || DEFAULT_JUMBO_STORE_CODE;
}

function isJumboPlaceholderImageUrl(imageUrl: string) {
  const normalizedUrl = normalizeString(imageUrl).toLowerCase();
  if (!normalizedUrl) {
    return true;
  }

  try {
    const parsedUrl = new URL(normalizedUrl);
    return (
      parsedUrl.hostname === "jumbo.com.do" &&
      parsedUrl.pathname.includes("/media/catalog/product/placeholder/")
    );
  } catch {
    return normalizedUrl.includes("/media/catalog/product/placeholder/");
  }
}

export function extractJumboImageUrls(product: JumboProductImageFields) {
  return dedupeComparableUrls([
    product.image?.url,
    product.small_image?.url,
    product.thumbnail?.url,
    ...(product.media_gallery ?? [])
      .filter((image) => !image.disabled)
      .map((image) => image.url),
  ])
    .filter((imageUrl) => !isJumboPlaceholderImageUrl(imageUrl))
    .map(normalizeNacionalImageUrl);
}
