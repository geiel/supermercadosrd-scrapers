export type PurchaseMode = "unit" | "measure";

export type PurchaseTerms = {
  mode: PurchaseMode;
  unit: string;
  minimum: string;
  increment: string;
  maximum: string | null;
  priceReferenceQuantity: string;
  source: string;
  evidence: Record<string, unknown>;
};

type PurchaseTermsInput = {
  mode: PurchaseMode;
  unit: string;
  minimum: unknown;
  increment: unknown;
  maximum?: unknown;
  priceReferenceQuantity?: unknown;
  source: string;
  evidence: Record<string, unknown>;
};

function positiveDecimal(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return (Math.round(parsed * 1000) / 1000).toString();
}

function isWholeDecimal(value: string) {
  return Number.isInteger(Number(value));
}

export function normalizePurchaseUnit(value: unknown, fallback = "UND") {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace("LIBRAS", "LB")
    .replace("LIBRA", "LB")
    .replace("KILOGRAMOS", "KG")
    .replace("KILOGRAMO", "KG")
    .replace("UNIDADES", "UND")
    .replace("UNIDAD", "UND")
    .replace(/^UN\.?$/, "UND")
    .replace(/^UNIT$/, "UND");

  if (["LB", "KG", "UND", "GR", "OZ", "L", "ML"].includes(normalized)) {
    return normalized;
  }

  return fallback;
}

export function buildPurchaseTerms(
  input: PurchaseTermsInput
): PurchaseTerms | undefined {
  const minimum = positiveDecimal(input.minimum);
  const increment = positiveDecimal(input.increment);
  const maximum =
    input.maximum === null || input.maximum === undefined
      ? null
      : positiveDecimal(input.maximum);
  const priceReferenceQuantity =
    positiveDecimal(input.priceReferenceQuantity ?? 1);
  const unit = normalizePurchaseUnit(input.unit);
  const modeUnitMismatch =
    (input.mode === "unit" && unit !== "UND") ||
    (input.mode === "measure" && unit === "UND");
  const fractionalWholeUnitQuantity =
    input.mode === "unit" &&
    minimum !== null &&
    increment !== null &&
    (!isWholeDecimal(minimum) || !isWholeDecimal(increment));

  if (
    !minimum ||
    !increment ||
    !priceReferenceQuantity ||
    modeUnitMismatch ||
    fractionalWholeUnitQuantity ||
    (maximum !== null && Number(maximum) < Number(minimum))
  ) {
    const observedFields = Object.entries(input.evidence)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key]) => key);
    if (observedFields.length > 0) {
      console.error(
        `[PURCHASE_TERMS] source=${input.source} invalid_fields=${observedFields.join(",")}`
      );
    }
    return undefined;
  }

  return {
    mode: input.mode,
    unit,
    minimum,
    increment,
    maximum,
    priceReferenceQuantity,
    source: input.source,
    evidence: input.evidence,
  };
}

export function inferModeFromUnit(unit: string) {
  return normalizePurchaseUnit(unit) === "UND" ? "unit" : "measure";
}
