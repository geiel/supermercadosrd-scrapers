// Bravo sometimes re-lists a product under a new idArticulo. The old id then
// answers `notfound` and the offer would be hidden for good. Bravo keeps its own
// product code (idexternoArticulo) across ids; it is also the number in its image
// URLs. These pure helpers decide whether a search result is the same product.

export type BravoArticle = {
  idArticulo: number;
  idexternoArticulo: string;
  nombreArticulo: string;
  idTipounidadArticulo?: number | null;
  eans?: string[];
};

export type BravoRelinkEvidence = {
  oldArticleId: number;
  /** Bravo product codes known for this product. */
  codes: string[];
  /**
   * Where the codes come from, strongest first: recorded for the failed article
   * by the price job, visible product images, or only hidden product images.
   */
  codeSource: "recorded" | "images" | "hidden_images";
  /** Bravo's own name for the old article, when it was recorded. */
  previousBravoName: string | null;
  /** Bravo purchase type of the old article (1 unit, 2 weight), when recorded. */
  previousPurchaseType: number | null;
  /** Our offer's purchase mode, used when the old type was not recorded. */
  purchaseMode: "unit" | "measure" | null;
  productName: string | null;
  /** product_measurement_label of our product, e.g. "250 GR". */
  presentation: string | null;
  /** Our global ids (EAN/UPC) for the product. */
  globalIds: string[];
};

export type ReplacementChoice =
  | { status: "candidate"; article: BravoArticle }
  | { status: "none" }
  | { status: "ambiguous"; articleIds: number[] };

export type ReplacementDecision =
  | { accept: true; reason: string }
  | { accept: false; reason: string };

const BRAVO_IMAGE_CODE = /superbravo\.com\.do\/images\/catalogo\/[a-z]+\/(\d+)_\d+\./gi;

export function bravoCodesFromImageUrls(urls: Array<string | null | undefined>) {
  const codes = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    for (const match of url.matchAll(BRAVO_IMAGE_CODE)) {
      codes.add(normalizeCode(match[1]));
    }
  }
  return [...codes];
}

/**
 * Which Bravo codes identify the product. A code recorded for the failed
 * article is the only one used; otherwise visible images, and hidden images
 * only as a last resort (decideReplacement then demands a barcode match).
 */
export function selectBravoCodes(input: {
  recordedCode: string | null;
  visibleImageCodes: string[];
  hiddenImageCodes: string[];
}): Pick<BravoRelinkEvidence, "codes" | "codeSource"> {
  const recorded = input.recordedCode?.trim();
  if (recorded) return { codes: [normalizeCode(recorded)], codeSource: "recorded" };
  if (input.visibleImageCodes.length > 0) {
    return { codes: input.visibleImageCodes, codeSource: "images" };
  }
  return { codes: input.hiddenImageCodes, codeSource: "hidden_images" };
}

export function bravoArticleIdFromApi(api: string | null | undefined) {
  const match = api?.match(/[?&]idArticulo=(\d+)(?:&|$)/);
  return match ? Number(match[1]) : null;
}

export function bravoArticleApi(articleId: number) {
  return `https://bravova-api.superbravo.com.do/public/articulo/get?idArticulo=${articleId}`;
}

function normalizeCode(value: string | number) {
  return String(value).trim().replace(/^0+(?=\d)/, "");
}

export function normalizeGlobalId(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

// Bravo OR-s the words, so filler words only pull in unrelated articles.
const SEARCH_STOPWORDS = new Set([
  "A", "AL", "CON", "DE", "DEL", "EL", "EN", "LA", "LAS", "LOS", "P", "PARA", "POR", "SIN", "Y",
]);

/** The query sent to Bravo's fuzzy search: its own old name when known. */
export function bravoSearchQuery(evidence: BravoRelinkEvidence) {
  const name = evidence.previousBravoName?.trim() || evidence.productName?.trim() || "";
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !SEARCH_STOPWORDS.has(word.toUpperCase()))
    .join(" ");
}

export function chooseReplacement(
  evidence: BravoRelinkEvidence,
  results: BravoArticle[]
): ReplacementChoice {
  const codes = new Set(evidence.codes.map(normalizeCode));
  const byId = new Map<number, BravoArticle>();
  for (const article of results) {
    if (article.idArticulo === evidence.oldArticleId) continue;
    if (!codes.has(normalizeCode(article.idexternoArticulo))) continue;
    byId.set(article.idArticulo, article);
  }

  const matches = [...byId.values()];
  if (matches.length === 0) return { status: "none" };
  if (matches.length > 1) {
    return { status: "ambiguous", articleIds: matches.map((a) => a.idArticulo) };
  }
  return { status: "candidate", article: matches[0] };
}

type Size = { dimension: "mass" | "volume"; quantity: number; fromOunces: boolean };

const UNIT_FACTORS: Record<string, Array<[Size["dimension"], number]>> = {
  KG: [["mass", 1000]],
  GR: [["mass", 1]],
  GRS: [["mass", 1]],
  G: [["mass", 1]],
  LB: [["mass", 453.59237]],
  LBS: [["mass", 453.59237]],
  // Labels mix weight and fluid ounces; accept either reading.
  OZ: [
    ["mass", 28.349523125],
    ["volume", 29.5735295625],
  ],
  ONZ: [
    ["mass", 28.349523125],
    ["volume", 29.5735295625],
  ],
  ML: [["volume", 1]],
  CC: [["volume", 1]],
  CL: [["volume", 10]],
  LT: [["volume", 1000]],
  LTR: [["volume", 1000]],
  L: [["volume", 1000]],
};

export function parseSizes(text: string | null | undefined): Size[] {
  if (!text) return [];
  const sizes: Size[] = [];
  const pattern = /(\d+(?:[.,]\d+)?)\s*(KG|GRS|GR|G|LBS|LB|ONZ|OZ|ML|CC|CL|LTR|LT|L)(?![A-Z])/gi;
  for (const match of text.toUpperCase().matchAll(pattern)) {
    const amount = Number(match[1].replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    for (const [dimension, factor] of UNIT_FACTORS[match[2]] ?? []) {
      sizes.push({ dimension, quantity: amount * factor, fromOunces: match[2].endsWith("Z") });
    }
  }
  return sizes;
}

function close(a: number, b: number) {
  return Math.abs(a - b) / Math.max(a, b) <= 0.03;
}

/**
 * true/false when the two sides can be compared, null when they cannot (one is
 * a weight and the other a volume, e.g. 375 g of oil labelled 411 ml).
 * Ounces may be fluid or weight, so they match either reading by number.
 */
function sizesAgree(left: Size[], right: Size[]): boolean | null {
  let comparable = false;
  for (const a of left) {
    for (const b of right) {
      if (a.dimension === b.dimension || a.fromOunces || b.fromOunces) {
        comparable = true;
        if (close(a.quantity, b.quantity)) return true;
      }
    }
  }
  return comparable ? false : null;
}

function sizeConflict(evidence: BravoRelinkEvidence, article: BravoArticle) {
  const newSizes = parseSizes(article.nombreArticulo);
  if (newSizes.length === 0) return null;

  // Bravo-to-Bravo first: its names can carry a wrong size, but the same one.
  const previous = parseSizes(evidence.previousBravoName);
  if (previous.length > 0) {
    return sizesAgree(previous, newSizes) === false ? "size_differs_from_old_bravo_name" : null;
  }

  const ours = parseSizes(evidence.presentation);
  if (ours.length > 0 && sizesAgree(ours, newSizes) === false) {
    return "size_differs_from_product";
  }
  return null;
}

// Units in a pack: "3 PACK", "PK 6", "X5", "6X55 ML", "24 UN". Bravo's
// "24/1" supplier case notation is not a pack count and is ignored.
const PACK_PATTERNS = [
  /(\d+)\s*-?\s*(?:PACK|PK|MPK|PAQ)(?![A-Z])/,
  /(?:^|[^A-Z])(?:PACK|PK|MPK)\s*(?:DE\s*)?(\d+)/,
  /(?:^|[^A-Z0-9])X\s*(\d+)(?![\d.,]*\s*(?:KG|GRS|GR|G|LBS|LB|ONZ|OZ|ML|CC|CL|LTR|LT|L)(?![A-Z]))/,
  /(?:^|[^0-9/])(\d+)\s*X\s*\d/,
  /(?:^|[^0-9/])(\d+)\s*(?:UNIDADES|UNIDAD|UNDS|UND|UNID|UN|U|PZS|PZ)(?![A-Z])/,
];

export function parsePackCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const upper = text
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  for (const pattern of PACK_PATTERNS) {
    const match = upper.match(pattern);
    const count = match ? Number(match[1]) : NaN;
    if (Number.isInteger(count) && count > 0) return count;
  }
  return null;
}

function packConflict(evidence: BravoRelinkEvidence, article: BravoArticle) {
  const next = parsePackCount(article.nombreArticulo);
  // Bravo's old name decides when it states a count; otherwise fall through to ours.
  const previous = parsePackCount(evidence.previousBravoName);
  if (previous !== null) {
    if (next === null) return previous > 1 ? "pack_count_changed" : null;
    return previous === next ? null : "pack_count_changed";
  }

  // Our name states a pack ("3 Pack") that Bravo's article no longer has.
  const fromName = parsePackCount(evidence.productName);
  if (fromName !== null && fromName > 1 && next !== fromName) return "pack_count_changed";
  // Our measured count is only compared with a count Bravo states: Bravo often
  // writes supplier cases ("4/1") or nothing for the same pack.
  const measured = parsePackCount(evidence.presentation);
  if (next !== null && measured !== null && next !== measured) return "pack_count_changed";
  return null;
}

function purchaseTypeConflict(evidence: BravoRelinkEvidence, article: BravoArticle) {
  const next = Number(article.idTipounidadArticulo);
  if (next !== 1 && next !== 2) return null;
  if (evidence.previousPurchaseType === 1 || evidence.previousPurchaseType === 2) {
    return evidence.previousPurchaseType === next ? null : "purchase_type_changed";
  }
  if (evidence.purchaseMode === "unit" && next === 2) return "purchase_type_changed";
  if (evidence.purchaseMode === "measure" && next === 1) return "purchase_type_changed";
  return null;
}

export function decideReplacement(
  evidence: BravoRelinkEvidence,
  article: BravoArticle,
  linkedToAnotherProduct: boolean
): ReplacementDecision {
  if (linkedToAnotherProduct) {
    return { accept: false, reason: "article_linked_to_another_product" };
  }

  const ours = new Set(evidence.globalIds.map(normalizeGlobalId).filter(Boolean));
  const eanMatch = (article.eans ?? []).some((ean) => ours.has(normalizeGlobalId(ean)));
  const conflicts = [
    sizeConflict(evidence, article),
    packConflict(evidence, article),
    purchaseTypeConflict(evidence, article),
    // Codes from hidden images, or from images of several Bravo articles, are
    // not trusted on their own.
    evidence.codeSource === "hidden_images" ? "code_only_from_hidden_images" : null,
    evidence.codeSource === "images" && evidence.codes.length > 1 ? "several_bravo_codes" : null,
  ].filter((value): value is string => value !== null);

  if (conflicts.length > 0 && !eanMatch) {
    return { accept: false, reason: conflicts.join(",") };
  }

  return {
    accept: true,
    reason: eanMatch ? "same_code_and_barcode" : "same_code",
  };
}
