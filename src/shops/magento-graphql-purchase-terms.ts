import { z } from "zod";
import {
  buildPurchaseTerms,
  normalizePurchaseUnit,
} from "../purchase-terms.js";

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

type MagentoGraphqlPurchaseFields = z.infer<
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

export function extractMagentoGraphqlPurchaseTerms(
  product: MagentoGraphqlPurchaseFields,
  input: {
    source: string;
  }
) {
  const rawPesoVariable = getCustomAttribute(product, "peso_variable");
  const pesoVariable = parseBoolean(rawPesoVariable);

  if (pesoVariable === false) {
    return null;
  }

  if (pesoVariable !== true) {
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
    evidence: {
      label_peso_variable: product.label_peso_variable,
      min_qty: product.min_qty,
      qty_increments: product.qty_increments,
      peso_variable: rawPesoVariable,
    },
  });
}
