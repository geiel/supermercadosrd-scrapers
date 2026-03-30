const EXCLUDED_TOP_LEVEL_CATEGORY_SLUGS = [
  "hogar-y-electrodomesticos",
  "ropa",
];

const ALLOWED_EXCEPTION_KEYWORDS = [
  "pila",
  "pilas",
  "bateria",
  "baterias",
  "duracell",
  "energizer",
  "rayovac",
];

function normalizeCatalogValue(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function isAllowedSirenaCatalogException(productName: string) {
  const normalizedName = normalizeCatalogValue(productName);

  return ALLOWED_EXCEPTION_KEYWORDS.some((keyword) =>
    normalizedName.includes(keyword)
  );
}

export function shouldIgnoreSirenaCatalogProduct(input: {
  productName: string;
  topLevelCategorySlug: string;
  categoryPath?: string | null;
}) {
  if (isAllowedSirenaCatalogException(input.productName)) {
    return false;
  }

  const normalizedTopLevelSlug = input.topLevelCategorySlug.trim().toLowerCase();
  if (
    EXCLUDED_TOP_LEVEL_CATEGORY_SLUGS.some((slug) => normalizedTopLevelSlug === slug)
  ) {
    return true;
  }

  const normalizedCategoryPath = normalizeCatalogValue(input.categoryPath);
  return EXCLUDED_TOP_LEVEL_CATEGORY_SLUGS.some((slug) =>
    normalizedCategoryPath.includes(slug.replace(/-/g, " "))
  );
}
