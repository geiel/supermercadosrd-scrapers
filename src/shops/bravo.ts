import { z } from "zod";
import { fetchWithRetry, getBravoHeaders } from "../http-client.js";
import { error, notFound, ok } from "../result.js";
import type {
  FetchWithRetryConfig,
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
  const purchaseTerms = extractBravoPurchaseTerms(data, input);

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

export async function getBravoArticle(
  articleId: number,
  requestConfig?: FetchWithRetryConfig
): Promise<BravoArticle | null> {
  const response = await fetchWithRetry(
    bravoArticleApi(articleId),
    { headers: getBravoHeaders() },
    requestConfig
  );
  if (!response) return null;
  const json = (await response.json().catch(() => null)) as { data?: unknown } | null;
  return json?.data ? toBravoArticle(json.data) : null;
}
