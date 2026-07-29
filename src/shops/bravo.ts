import { z } from "zod";
import { fetchWithRetry, getBravoHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import {
  buildPurchaseTerms,
  inferModeFromUnit,
  normalizePurchaseUnit,
} from "../purchase-terms.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 6;

const productSchema = z
  .object({
    data: z.object({
      mincantArticuloArticulo: z.unknown().optional(),
      varcantArticuloArticulo: z.unknown().optional(),
      maxcantArticuloArticulo: z.unknown().optional(),
      associatedTienda: z.array(
        z.object({
          idTiendaArticuloTienda: z.number(),
          pvpArticuloTienda: z.number(),
          associatedOferta: z.array(
            z.object({
              precioReferenciaArticuloTiendaOferta: z.number(),
            })
          ),
        })
      ),
    }),
  })
  .or(
    z.object({
      errors: z.array(
        z.object({
          code: z.string(),
        })
      ),
    })
  );

export async function scrapeBravoPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  if (!input.api) {
    return error(shopId, "missing_api", false, true);
  }

  const response = await fetchWithRetry(
    input.api,
    { headers: getBravoHeaders() },
    requestConfig
  );

  if (!response) {
    return error(shopId, "request_failed", true, true);
  }

  const jsonResponse: unknown = await response.json().catch(() => null);
  if (!jsonResponse) {
    return error(shopId, "invalid_json", true, true);
  }

  const parsed = productSchema.safeParse(jsonResponse);
  if (!parsed.success) {
    return error(shopId, "invalid_payload", false, true);
  }

  if ("errors" in parsed.data) {
    return notFound(shopId, "product_not_found", true);
  }

  const preferred = parsed.data.data.associatedTienda.find(
    (shop) => shop.idTiendaArticuloTienda === 1000
  );
  const selected = preferred ?? parsed.data.data.associatedTienda[0];

  if (!selected) {
    return notFound(shopId, "product_not_found", true);
  }

  const data = parsed.data.data;
  const unit = normalizePurchaseUnit(input.baseUnit ?? input.unit);
  const purchaseTerms = buildPurchaseTerms({
    mode: inferModeFromUnit(unit),
    unit,
    minimum: data.mincantArticuloArticulo,
    increment: data.varcantArticuloArticulo,
    maximum: data.maxcantArticuloArticulo,
    priceReferenceQuantity: 1,
    source: "bravo_product_api",
    evidence: {
      mincantArticuloArticulo: data.mincantArticuloArticulo,
      varcantArticuloArticulo: data.varcantArticuloArticulo,
      maxcantArticuloArticulo: data.maxcantArticuloArticulo,
    },
  });

  return ok(
    shopId,
    String(selected.pvpArticuloTienda),
    selected.associatedOferta[0]
      ? String(selected.associatedOferta[0].precioReferenciaArticuloTiendaOferta)
      : null,
    null,
    undefined,
    undefined,
    purchaseTerms
  );
}
