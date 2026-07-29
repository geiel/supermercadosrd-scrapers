import {
  buildPurchaseTerms,
  normalizePurchaseUnit,
} from "../purchase-terms.js";
import type { ScrapePriceInput } from "../types.js";

type BravoPurchaseFields = {
  idTipounidadArticulo?: unknown;
  mincantArticuloArticulo?: unknown;
  varcantArticuloArticulo?: unknown;
  maxcantArticuloArticulo?: unknown;
};

export function extractBravoPurchaseTerms(
  product: BravoPurchaseFields,
  input: Pick<ScrapePriceInput, "unit" | "baseUnit" | "baseUnitAmount">
) {
  const purchaseType = Number(product.idTipounidadArticulo);
  if (purchaseType !== 1 && purchaseType !== 2) {
    return undefined;
  }

  const mode = purchaseType === 1 ? "unit" : "measure";
  const unit =
    purchaseType === 1
      ? "UND"
      : normalizePurchaseUnit(input.baseUnit ?? input.unit, "");

  if (!unit || (mode === "measure" && unit === "UND")) {
    return undefined;
  }

  return buildPurchaseTerms({
    mode,
    unit,
    minimum: product.mincantArticuloArticulo,
    increment: product.varcantArticuloArticulo,
    maximum: product.maxcantArticuloArticulo,
    priceReferenceQuantity: 1,
    source: "bravo_product_api",
    evidence: {
      idTipounidadArticulo: product.idTipounidadArticulo,
      mincantArticuloArticulo: product.mincantArticuloArticulo,
      varcantArticuloArticulo: product.varcantArticuloArticulo,
      maxcantArticuloArticulo: product.maxcantArticuloArticulo,
      productUnit: input.unit,
      baseUnit: input.baseUnit,
      baseUnitAmount: input.baseUnitAmount,
    },
  });
}
