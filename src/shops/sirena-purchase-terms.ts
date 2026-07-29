import {
  buildPurchaseTerms,
  normalizePurchaseUnit,
  type PurchaseTerms,
} from "../purchase-terms.js";
import type { NormalizedSirenaVtexProduct } from "../sirena-vtex.js";
import { formatUnit, parseProductUnit } from "../unit-utils.js";
import type { ScrapePriceInput } from "../types.js";

type SirenaLegacyPurchaseFields = {
  minimum?: unknown;
  producttype_step?: unknown;
  producttype_decimal?: unknown;
};

function parseDecimalSupport(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }

    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      return numeric > 0;
    }
  }

  return null;
}

function hasExplicitContentAmount(unit: string | null | undefined) {
  if (!unit?.trim()) {
    return false;
  }

  return /^\d+(?:\.\d+)?\s+/.test(formatUnit(unit));
}

function standardTermsOrNull(
  terms: PurchaseTerms | undefined
): PurchaseTerms | null | undefined {
  if (!terms) {
    return undefined;
  }

  return terms.minimum === "1" &&
    terms.increment === "1" &&
    terms.maximum === null
    ? null
    : terms;
}

export function extractSirenaLegacyPurchaseTerms(
  product: SirenaLegacyPurchaseFields,
  input: Pick<ScrapePriceInput, "unit" | "baseUnit" | "baseUnitAmount">
) {
  const supportsDecimals = parseDecimalSupport(product.producttype_decimal);
  if (supportsDecimals === null) {
    return undefined;
  }

  const parsedProductUnit = parseProductUnit(input);
  if (!parsedProductUnit) {
    return undefined;
  }

  const source = "sirena_legacy_api";
  const evidence = {
    minimum: product.minimum,
    producttype_step: product.producttype_step,
    producttype_decimal: product.producttype_decimal,
    productUnit: input.unit,
    baseUnit: input.baseUnit,
    baseUnitAmount: input.baseUnitAmount,
  };

  if (
    !supportsDecimals &&
    (parsedProductUnit.measurement === "count" ||
      hasExplicitContentAmount(input.unit) ||
      parsedProductUnit.amount !== 1)
  ) {
    return standardTermsOrNull(
      buildPurchaseTerms({
        mode: "unit",
        unit: "UND",
        minimum: product.minimum,
        increment: product.producttype_step,
        maximum: null,
        priceReferenceQuantity: 1,
        source,
        evidence,
      })
    );
  }

  const unit = normalizePurchaseUnit(parsedProductUnit.normalizedUnit, "");
  if (!unit || unit === "UND") {
    return undefined;
  }

  return buildPurchaseTerms({
    mode: "measure",
    unit,
    minimum: product.minimum,
    increment: product.producttype_step,
    maximum: null,
    priceReferenceQuantity: 1,
    source,
    evidence,
  });
}

function normalizeVtexPurchaseUnit(value: string | null) {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (["UN", "UN.", "UND", "UNIT", "UNIDAD"].includes(normalized)) {
    return "UND";
  }
  if (normalized === "G") {
    return "GR";
  }

  return normalizePurchaseUnit(normalized, "");
}

export function extractSirenaVtexPurchaseTerms(
  product: Pick<
    NormalizedSirenaVtexProduct,
    "measurementUnit" | "unitMultiplier"
  >
) {
  const unit = normalizeVtexPurchaseUnit(product.measurementUnit);
  if (!unit) {
    return undefined;
  }

  const evidence = {
    measurementUnit: product.measurementUnit,
    unitMultiplier: product.unitMultiplier,
  };

  if (unit === "UND") {
    return null;
  }

  return buildPurchaseTerms({
    mode: "measure",
    unit,
    minimum: product.unitMultiplier,
    increment: product.unitMultiplier,
    maximum: null,
    priceReferenceQuantity: 1,
    source: "sirena_vtex_api",
    evidence,
  });
}
