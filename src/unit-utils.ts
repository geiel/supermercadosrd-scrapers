export type Measurement = "weight" | "volume" | "count" | "length";

export const measurementByUnit: Record<string, Measurement | undefined> = {
  LB: "weight",
  OZ: "weight",
  GR: "weight",
  KG: "weight",
  ML: "volume",
  CC: "volume",
  LT: "volume",
  CL: "volume",
  GL: "volume",
  UND: "count",
  PAG: "count",
  M: "length",
  FT: "length",
  YD: "length",
};

export type ParsedUnit = {
  measurement: Measurement;
  base: number;
  amount: number;
  normalizedUnit: string;
};

export function formatAmount(value: number): string {
  if (Number.isInteger(value)) {
    return value.toString();
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
}

function convertToBase(amount: number, unit: string, measurement: Measurement) {
  switch (measurement) {
    case "weight": {
      switch (unit) {
        case "GR":
          return amount;
        case "OZ":
          return amount * 28.35;
        case "LB":
          return amount * 453.59237;
        case "KG":
          return amount * 1000;
        default:
          return 0;
      }
    }
    case "volume": {
      switch (unit) {
        case "CC":
        case "ML":
          return amount;
        case "CL":
          return amount * 10;
        case "LT":
          return amount * 1000;
        case "GL":
          return amount * 3785.411784;
        default:
          return 0;
      }
    }
    case "count":
      return amount;
    case "length": {
      switch (unit) {
        case "M":
          return amount * 100;
        case "FT":
          return amount * 30.48;
        case "YD":
          return amount * 91.44;
        default:
          return 0;
      }
    }
  }
}

export function formatUnit(unit: string) {
  const normalized = unit
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)$/, "$1 $2");
  const parts = normalized.split(/\s+/);

  if (parts.length <= 1) {
    return normalized.toUpperCase();
  }

  const unitAmount = parts[0];
  const unitType = parts[1].toUpperCase();

  if (unitType === "GRAMOS" || unitType === "GRS" || unitType === "G") {
    return `${unitAmount} GR`;
  }

  if (
    unitType === "UDS" ||
    unitType === "UN" ||
    unitType === "UNIDADES" ||
    unitType === "UND/PAQ" ||
    unitType === "UNIDAD"
  ) {
    return `${unitAmount} UND`;
  }

  if (
    unitType === "P" ||
    unitType === "PAG" ||
    unitType === "PAGS" ||
    unitType === "PAGINA" ||
    unitType === "PAGINAS"
  ) {
    return `${unitAmount} PAG`;
  }

  if (unitType === "ONZ") {
    return `${unitAmount} OZ`;
  }

  if (unitType === "L") {
    return `${unitAmount} LT`;
  }

  if (unitType === "LBS") {
    return `${unitAmount} LB`;
  }

  if (unitType.endsWith(".")) {
    return `${unitAmount} ${unitType.slice(0, -1)}`;
  }

  return `${unitAmount} ${unitType}`;
}

export function parseUnit(unitRaw: string): ParsedUnit | null {
  const trimmed = unitRaw.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  let amount = Number(parts[0]);
  let unit = parts[1];

  if (Number.isNaN(amount)) {
    amount = 1;
    unit = parts[0];
  }

  if (!unit || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const normalizedUnit = unit.toUpperCase();
  const measurement = measurementByUnit[normalizedUnit];
  if (!measurement) {
    return null;
  }

  const base = convertToBase(amount, normalizedUnit, measurement);
  if (!base) {
    return null;
  }

  return { measurement, base, amount, normalizedUnit };
}

export function parseProductUnit(product: {
  unit?: string | null;
  baseUnit?: string | null;
  baseUnitAmount?: string | number | null;
}) {
  const normalizedBaseUnit = product.baseUnit?.trim().toUpperCase() ?? null;
  const baseUnitAmount = Number(product.baseUnitAmount);

  if (
    normalizedBaseUnit &&
    Number.isFinite(baseUnitAmount) &&
    baseUnitAmount > 0 &&
    measurementByUnit[normalizedBaseUnit]
  ) {
    return parseUnit(`${formatAmount(baseUnitAmount)} ${normalizedBaseUnit}`);
  }

  return product.unit ? parseUnit(product.unit) : null;
}
