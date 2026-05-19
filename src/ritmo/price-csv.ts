import { parse } from "csv-parse/sync";

export type RitmoPriceCsvRow = {
  rowIndex: number;
  sku: string;
  description: string;
  rawBarcode: string | null;
  price: string | null;
  csvBrand: string | null;
};

export type RitmoPriceCsvParseResult = {
  rows: RitmoPriceCsvRow[];
  duplicateSkus: string[];
};

type HeaderIndexes = {
  skuIndex: number;
  descriptionIndex: number;
  barcodeIndex: number;
  priceIndex: number;
  brandIndex: number;
};

function normalizeText(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeHeader(value: unknown) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function cleanSpreadsheetText(value: unknown) {
  const normalized = normalizeText(value);
  const match = normalized.match(/^="(.*)"$/);
  return match ? match[1]?.trim() ?? "" : normalized;
}

function normalizePrice(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  const rawValue = normalizeText(value);
  if (!rawValue) {
    return null;
  }

  const sanitizedValue = rawValue.replace(/[^\d.,-]/g, "");
  if (!sanitizedValue) {
    return null;
  }

  let normalizedValue = sanitizedValue;
  if (sanitizedValue.includes(",") && sanitizedValue.includes(".")) {
    const lastComma = sanitizedValue.lastIndexOf(",");
    const lastDot = sanitizedValue.lastIndexOf(".");
    normalizedValue =
      lastComma > lastDot
        ? sanitizedValue.replace(/\./g, "").replace(",", ".")
        : sanitizedValue.replace(/,/g, "");
  } else if (sanitizedValue.includes(",") && !sanitizedValue.includes(".")) {
    normalizedValue = sanitizedValue.replace(/\./g, "").replace(",", ".");
  } else {
    normalizedValue = sanitizedValue.replace(/,/g, "");
  }

  const parsed = Number(normalizedValue);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

function inferHeaderIndexes(headerRow: unknown[]): HeaderIndexes {
  const headers = headerRow.map((header) => normalizeHeader(header));
  const findIndex = (patterns: string[]) =>
    headers.findIndex((header) =>
      patterns.some((pattern) => header === pattern || header.includes(pattern))
    );

  const skuIndex = findIndex(["sku", "codigo", "codigoritmo"]);
  const descriptionIndex = findIndex([
    "descripcion",
    "description",
    "producto",
    "item",
    "nombre",
  ]);
  const barcodeIndex = findIndex([
    "codigodebarras",
    "barcode",
    "barras",
    "ean",
    "gtin",
    "upc",
  ]);
  const priceIndex = findIndex(["precio", "pvp", "price"]);
  const brandIndex = findIndex(["marca", "brand"]);

  if (skuIndex < 0) {
    throw new Error("Ritmo CSV must include a SKU column");
  }

  if (descriptionIndex < 0) {
    throw new Error("Ritmo CSV must include a description column");
  }

  if (priceIndex < 0) {
    throw new Error("Ritmo CSV must include a price column");
  }

  return {
    skuIndex,
    descriptionIndex,
    barcodeIndex,
    priceIndex,
    brandIndex,
  };
}

function rowsFromCsvRecords(records: unknown[][]): RitmoPriceCsvParseResult {
  if (records.length <= 1) {
    throw new Error("Ritmo CSV does not contain product rows");
  }

  const indexes = inferHeaderIndexes(records[0] ?? []);
  const rowsBySku = new Map<string, RitmoPriceCsvRow>();
  const duplicateSkuSet = new Set<string>();

  for (let index = 1; index < records.length; index += 1) {
    const record = records[index] ?? [];
    const sku = cleanSpreadsheetText(record[indexes.skuIndex]);
    const description = cleanSpreadsheetText(record[indexes.descriptionIndex]);

    if (!sku || !description) {
      continue;
    }

    if (rowsBySku.has(sku)) {
      duplicateSkuSet.add(sku);
      continue;
    }

    rowsBySku.set(sku, {
      rowIndex: index + 1,
      sku,
      description,
      rawBarcode:
        indexes.barcodeIndex >= 0
          ? cleanSpreadsheetText(record[indexes.barcodeIndex]) || null
          : null,
      price: normalizePrice(record[indexes.priceIndex]),
      csvBrand:
        indexes.brandIndex >= 0
          ? cleanSpreadsheetText(record[indexes.brandIndex]) || null
          : null,
    });
  }

  return {
    rows: Array.from(rowsBySku.values()),
    duplicateSkus: Array.from(duplicateSkuSet),
  };
}

export function parseRitmoPriceCsv(content: Buffer | string): RitmoPriceCsvParseResult {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  const records = parse(text, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  }) as unknown[][];

  return rowsFromCsvRecords(records);
}

export function isPositivePrice(price: string | null) {
  if (!price) {
    return false;
  }

  const parsed = Number(price);
  return Number.isFinite(parsed) && parsed > 0;
}
