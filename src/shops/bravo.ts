import { z } from "zod";
import { fetchWithRetry, getBravoHeaders } from "../http-client.js";
import { error, locationInStock, notFound, ok, withStock } from "../result.js";
import type {
  FetchWithRetryConfig,
  ScrapeLocationAvailability,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";
import { extractBravoPurchaseTerms } from "./bravo-purchase-terms.js";
import { bravoArticleApi, type BravoArticle } from "../bravo-relink.js";

const shopId = 6;

const productSchema = z
  .object({
    data: z.object({
      idArticulo: z.number().optional(),
      idexternoArticulo: z.union([z.string(), z.number()]).optional(),
      nombreArticulo: z.string().optional(),
      associatedEan: z
        .array(z.object({ idEan: z.union([z.string(), z.number()]) }))
        .optional(),
      idTipounidadArticulo: z.unknown().optional(),
      mincantArticuloArticulo: z.unknown().optional(),
      varcantArticuloArticulo: z.unknown().optional(),
      maxcantArticuloArticulo: z.unknown().optional(),
      associatedTienda: z.array(
        z.object({
          idTiendaArticuloTienda: z.number(),
          pvpArticuloTienda: z.number(),
          disponibleArticuloTienda: z.boolean().nullish(),
          stockArticuloTienda: z.number().nullish(),
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

  return bravoPriceFromPayload(jsonResponse, input);
}

/** Price result from one /articulo/get payload (shared with the relink step). */
export function bravoPriceFromPayload(
  jsonResponse: unknown,
  input: ScrapePriceInput
): ScrapePriceResult {
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
  const purchaseTerms = extractBravoPurchaseTerms(data, input);
  const locations = bravoLocations(data.associatedTienda);

  return withStock(
    ok(
      shopId,
      String(selected.pvpArticuloTienda),
      bravoRegularPrice(selected),
      String(selected.idTiendaArticuloTienda),
      undefined,
      undefined,
      purchaseTerms
    ),
    // Bravo sells online from every branch: out of stock online only when no
    // branch has it. Without availability fields nothing is known, and the
    // stored branches stay.
    locations.length === 0
      ? {}
      : { locations, outOfStockOnline: !locations.some(bravoLocationInStock) }
  );
}

type BravoTienda = Extract<
  z.infer<typeof productSchema>,
  { data: unknown }
>["data"]["associatedTienda"][number];

function bravoRegularPrice(tienda: BravoTienda) {
  return tienda.associatedOferta[0]
    ? String(tienda.associatedOferta[0].precioReferenciaArticuloTiendaOferta)
    : null;
}

/** In stock at a branch: Bravo says it is available and has units left. */
export const bravoLocationInStock = locationInStock;

function bravoLocations(tiendas: BravoTienda[]): ScrapeLocationAvailability[] {
  return tiendas
    .filter((tienda) => typeof tienda.disponibleArticuloTienda === "boolean")
    .map((tienda) => ({
      externalId: String(tienda.idTiendaArticuloTienda),
      available: tienda.disponibleArticuloTienda === true,
      stock:
        typeof tienda.stockArticuloTienda === "number" &&
        Number.isFinite(tienda.stockArticuloTienda)
          ? tienda.stockArticuloTienda
          : null,
      currentPrice:
        tienda.pvpArticuloTienda > 0 ? String(tienda.pvpArticuloTienda) : null,
      regularPrice: bravoRegularPrice(tienda),
    }));
}

const BRAVO_API = "https://bravova-api.superbravo.com.do";

const articleSummarySchema = z.object({
  idArticulo: z.number(),
  idexternoArticulo: z.union([z.string(), z.number()]),
  nombreArticulo: z.string(),
  idTipounidadArticulo: z.number().nullish(),
  associatedEan: z
    .array(z.object({ idEan: z.union([z.string(), z.number()]) }))
    .nullish(),
});

const searchSchema = z.object({
  data: z.object({ list: z.array(z.unknown()) }),
});

function toBravoArticle(value: unknown): BravoArticle | null {
  const parsed = articleSummarySchema.safeParse(value);
  if (!parsed.success) return null;
  const article = parsed.data;
  return {
    idArticulo: article.idArticulo,
    idexternoArticulo: String(article.idexternoArticulo),
    nombreArticulo: article.nombreArticulo,
    idTipounidadArticulo: article.idTipounidadArticulo ?? null,
    eans: (article.associatedEan ?? []).map((ean) => String(ean.idEan)),
  };
}

/** One page of Bravo's fuzzy name search (words are OR-ed, best score first). */
export async function searchBravoArticles(
  query: string,
  requestConfig?: FetchWithRetryConfig
): Promise<BravoArticle[] | null> {
  if (!query.trim()) return [];
  const params = new URLSearchParams({
    "model.nombreArticulo": query,
    paginationMaxItems: "100",
    paginationOffset: "0",
    showOrder: "score",
  });
  const response = await fetchWithRetry(
    `${BRAVO_API}/public/articulo/search?${params}`,
    { headers: getBravoHeaders() },
    requestConfig
  );
  if (!response) return null;
  const json: unknown = await response.json().catch(() => null);
  const parsed = searchSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.data.list
    .map(toBravoArticle)
    .filter((article): article is BravoArticle => article !== null);
}

/** One article: its identity plus the raw payload, so the price can reuse it. */
export async function getBravoArticle(
  articleId: number,
  requestConfig?: FetchWithRetryConfig
): Promise<{ article: BravoArticle; payload: unknown } | null> {
  const response = await fetchWithRetry(
    bravoArticleApi(articleId),
    { headers: getBravoHeaders() },
    requestConfig
  );
  if (!response) return null;
  const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
  const article = payload?.data ? toBravoArticle(payload.data) : null;
  return article ? { article, payload } : null;
}
