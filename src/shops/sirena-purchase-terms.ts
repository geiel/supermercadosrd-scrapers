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
  if (["UN", "UN.", "UND", "UND.", "UNIT", "UNIDAD"].includes(normalized)) {
    return "UND";
  }
  if (normalized === "G") {
    return "GR";
  }

  return normalizePurchaseUnit(normalized, "");
}

function getDeclaredItemQuantity(value: string | null) {
  const match = value
    ?.trim()
    .match(/(\d+(?:[.,]\d+)?)\s*(LB|KG|G|GR|OZ|ML|L|UN\.?|UND\.?|UNIDAD(?:ES)?)\s*$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1].replace(",", "."));
  const unit = normalizeVtexPurchaseUnit(match[2]);
  return Number.isFinite(amount) && amount > 0 && unit
    ? { amount, unit }
    : null;
}

export function extractSirenaVtexPurchaseTerms(
  product: Pick<
    NormalizedSirenaVtexProduct,
    "measurementUnit" | "unitMultiplier"
  > &
    Partial<Pick<NormalizedSirenaVtexProduct, "itemNameComplete">>,
  input?: Pick<ScrapePriceInput, "unit" | "baseUnit" | "baseUnitAmount">
) {
  const unit = normalizeVtexPurchaseUnit(product.measurementUnit);
  if (!unit) {
    return undefined;
  }

  const evidence: Record<string, unknown> = {
    measurementUnit: product.measurementUnit,
    unitMultiplier: product.unitMultiplier,
    itemNameComplete: product.itemNameComplete,
    productUnit: input?.unit,
    baseUnit: input?.baseUnit,
    baseUnitAmount: input?.baseUnitAmount,
  };

  if (unit === "UND") {
    return null;
  }

  const declaredItemQuantity = getDeclaredItemQuantity(
    product.itemNameComplete ?? null
  );
  if (declaredItemQuantity?.unit === "UND") {
    return null;
  }

  const parsedProductUnit = input ? parseProductUnit(input) : null;
  if (
    parsedProductUnit &&
    (parsedProductUnit.measurement === "count" ||
      parsedProductUnit.normalizedUnit !== unit ||
      parsedProductUnit.amount !== 1)
  ) {
    return undefined;
  }

  let effectiveMultiplier = product.unitMultiplier;
  if (
    typeof effectiveMultiplier === "number" &&
    effectiveMultiplier > 20
  ) {
    if (
      declaredItemQuantity?.unit !== unit ||
      declaredItemQuantity.amount > 20
    ) {
      return undefined;
    }
    effectiveMultiplier = declaredItemQuantity.amount;
    evidence.correctedUnitMultiplier = effectiveMultiplier;
    evidence.correctionReason = "extreme_multiplier_conflicts_with_item_label";
  }

  return buildPurchaseTerms({
    mode: "measure",
    unit,
    minimum: effectiveMultiplier,
    increment: effectiveMultiplier,
    maximum: null,
    priceReferenceQuantity: 1,
    source: "sirena_vtex_api",
    evidence,
  });
}
