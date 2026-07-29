import {
  buildPurchaseTerms,
  inferModeFromUnit,
  normalizePurchaseUnit,
} from "../purchase-terms.js";

function extractScalar(html: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `(?:["']${escapedKey}["']|\\b${escapedKey}\\b)\\s*:\\s*(?:"([^"]*)"|'([^']*)'|(-?\\d+(?:\\.\\d+)?)|(true|false))`,
      "i"
    )
  );

  return match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function parseBoolean(value: string | null) {
  if (value === null) return null;
  if (value.toLowerCase() === "true" || value === "1") return true;
  if (value.toLowerCase() === "false" || value === "0") return false;
  return null;
}

export function extractMagentoPurchaseTerms(
  html: string,
  input: {
    unit?: string | null;
    source: string;
  }
) {
  const minAllowed = extractScalar(html, "minAllowed");
  const maxAllowed = extractScalar(html, "maxAllowed");
  const qtyIncrements = extractScalar(html, "qtyIncrements");
  const pesoVariable = extractScalar(html, "pesoVariable");

  if (minAllowed === null || qtyIncrements === null) {
    return undefined;
  }

  const isVariable = parseBoolean(pesoVariable);
  const hintedUnit = normalizePurchaseUnit(input.unit);
  const unit = isVariable === false ? "UND" : hintedUnit;

  return buildPurchaseTerms({
    mode: isVariable === true ? "measure" : inferModeFromUnit(unit),
    unit,
    minimum: minAllowed,
    increment: qtyIncrements,
    maximum: maxAllowed,
    priceReferenceQuantity: 1,
    source: input.source,
    evidence: {
      minAllowed,
      maxAllowed,
      qtyIncrements,
      pesoVariable,
    },
  });
}
