import { z } from "zod";
import {
  buildPurchaseTerms,
  normalizePurchaseUnit,
  type PurchaseTerms,
} from "../purchase-terms.js";
import type { ScrapePriceInput } from "../types.js";
import { formatUnit, parseProductUnit } from "../unit-utils.js";

export const magentoPurchaseTermsGraphqlFields = `
      label_peso_variable
      min_qty
      qty_increments
      custom_attributesV2 {
        items {
          code
          ... on AttributeValue {
            value
          }
        }
      }`;

export const magentoPurchaseTermsGraphqlSchema = z.object({
  label_peso_variable: z.string().nullable().optional(),
  min_qty: z.union([z.number(), z.string()]).nullable().optional(),
  qty_increments: z.union([z.number(), z.string()]).nullable().optional(),
  custom_attributesV2: z
    .object({
      items: z
        .array(
          z.object({
            code: z.string(),
            value: z.unknown().optional(),
          })
        )
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export type MagentoGraphqlPurchaseFields = z.infer<
  typeof magentoPurchaseTermsGraphqlSchema
>;

function parseBoolean(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return null;
}

function getCustomAttribute(
  product: MagentoGraphqlPurchaseFields,
  code: string
) {
  return product.custom_attributesV2?.items?.find(
    (attribute) => attribute.code === code
  )?.value;
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

export function extractMagentoGraphqlPurchaseTerms(
  product: MagentoGraphqlPurchaseFields,
  input: {
    source: string;
    productUnit?: Pick<
      ScrapePriceInput,
      "unit" | "baseUnit" | "baseUnitAmount"
    >;
  }
) {
  const rawPesoVariable = getCustomAttribute(product, "peso_variable");
  const pesoVariable = parseBoolean(rawPesoVariable);
  const evidence = {
    label_peso_variable: product.label_peso_variable,
    min_qty: product.min_qty,
    qty_increments: product.qty_increments,
    peso_variable: rawPesoVariable,
    productUnit: input.productUnit?.unit,
    baseUnit: input.productUnit?.baseUnit,
    baseUnitAmount: input.productUnit?.baseUnitAmount,
  };

  if (pesoVariable === false) {
    return standardTermsOrNull(
      buildPurchaseTerms({
        mode: "unit",
        unit: "UND",
        minimum: product.min_qty,
        increment: product.qty_increments,
        maximum: null,
        priceReferenceQuantity: 1,
        source: input.source,
        evidence,
      })
    );
  }

  if (pesoVariable === null && input.productUnit) {
    const parsedProductUnit = parseProductUnit(input.productUnit);
    if (!parsedProductUnit) {
      return undefined;
    }

    if (
      parsedProductUnit.measurement === "count" ||
      hasExplicitContentAmount(input.productUnit.unit) ||
      parsedProductUnit.amount !== 1
    ) {
      return standardTermsOrNull(
        buildPurchaseTerms({
          mode: "unit",
          unit: "UND",
          minimum: product.min_qty,
          increment: product.qty_increments,
          maximum: null,
          priceReferenceQuantity: 1,
          source: input.source,
          evidence,
        })
      );
    }

    const labelUnit = normalizePurchaseUnit(
      product.label_peso_variable,
      ""
    );
    if (
      !labelUnit ||
      labelUnit === "UND" ||
      labelUnit !== parsedProductUnit.normalizedUnit
    ) {
      return undefined;
    }
  } else if (pesoVariable !== true) {
    return undefined;
  }

  const unit = normalizePurchaseUnit(product.label_peso_variable, "");
  if (!unit || unit === "UND") {
    return undefined;
  }

  return buildPurchaseTerms({
    mode: "measure",
    unit,
    minimum: product.min_qty,
    increment: product.qty_increments,
    maximum: null,
    priceReferenceQuantity: 1,
    source: input.source,
    evidence,
  });
}
