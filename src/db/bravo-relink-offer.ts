import { and, eq, sql } from "drizzle-orm";
import { db } from "./client.js";
import { productsShopsPrices } from "./schema.js";
import {
  bravoArticleApi,
  bravoArticleIdFromApi,
  bravoCodesFromImageUrls,
  bravoSearchQuery,
  chooseReplacement,
  decideReplacement,
  type BravoRelinkEvidence,
} from "../bravo-relink.js";
import { getBravoArticle, scrapeBravoPrice, searchBravoArticles } from "../shops/bravo.js";
import type { ScrapePriceSuccess } from "../types.js";

const BRAVO_SHOP_ID = 6;

type RelinkRow = {
  productId: number;
  shopId: number;
  api: string | null;
  url: string;
  locationId: string | null;
  presentation?: string | null;
  purchaseMode: "unit" | "measure" | null;
  purchaseUnit: string | null;
};

export type BravoRelinkResult = {
  api: string;
  result: ScrapePriceSuccess;
};

function log(row: RelinkRow, message: string) {
  console.log(`[RELINK] bravo productId=${row.productId} ${message}`);
}

async function loadEvidence(row: RelinkRow, oldArticleId: number): Promise<BravoRelinkEvidence | null> {
  const rows = await db.execute<{
    name: string | null;
    image: string | null;
    images: string[] | null;
    globalIds: string[] | null;
    evidence: Record<string, unknown> | null;
  }>(sql`
    select p.name, p.image,
      (select json_agg(i."imageUrl") from product_images i where i."productId" = p.id) as "images",
      (select json_agg(g.value) from products_global_ids g where g."productId" = p.id) as "globalIds",
      x."purchaseTermsEvidence" as "evidence"
    from products p
    join products_shops_prices x on x."productId" = p.id and x."shopId" = ${BRAVO_SHOP_ID}
    where p.id = ${row.productId}
  `);
  const record = rows[0];
  if (!record) return null;

  const evidence = record.evidence ?? {};
  // The recorded code only counts when it belongs to the article that just failed.
  const recordedForOldArticle = Number(evidence.idArticulo) === oldArticleId;
  const recordedCode =
    recordedForOldArticle && evidence.idexternoArticulo != null
      ? [String(evidence.idexternoArticulo)]
      : [];
  const codes = [
    ...new Set([...recordedCode, ...bravoCodesFromImageUrls([record.image, ...(record.images ?? [])])]),
  ];
  const previousType = Number(evidence.idTipounidadArticulo);

  return {
    oldArticleId,
    codes,
    previousBravoName:
      recordedForOldArticle && typeof evidence.nombreArticulo === "string"
        ? evidence.nombreArticulo
        : null,
    previousPurchaseType: previousType === 1 || previousType === 2 ? previousType : null,
    purchaseMode: row.purchaseMode,
    productName: record.name,
    presentation: row.presentation ?? null,
    globalIds: record.globalIds ?? [],
  };
}

async function linkedToAnotherProduct(productId: number, articleId: number) {
  const rows = await db.execute(sql`
    select 1 from products_shops_prices
    where "shopId" = ${BRAVO_SHOP_ID} and "productId" <> ${productId}
      and substring(api from '[?&]idArticulo=([0-9]+)') = ${String(articleId)}
    union all
    select 1 from product_retailer_identifiers
    where "shopId" = ${BRAVO_SHOP_ID} and "productId" <> ${productId}
      and "normalizedSku" = ${String(articleId)} and active
    limit 1
  `);
  return rows.length > 0;
}

/**
 * Called when Bravo answers that the offer's article no longer exists. Looks for
 * the same product under a new idArticulo and, when it is certain, points the
 * offer at it. Returns null when the offer should be hidden as before.
 */
export async function relinkBravoOffer(row: RelinkRow): Promise<BravoRelinkResult | null> {
  if (row.shopId !== BRAVO_SHOP_ID) return null;
  const oldArticleId = bravoArticleIdFromApi(row.api);
  if (oldArticleId === null) return null;

  const evidence = await loadEvidence(row, oldArticleId);
  if (!evidence || evidence.codes.length === 0) {
    log(row, `old=${oldArticleId} skip=no_bravo_code`);
    return null;
  }

  const query = bravoSearchQuery(evidence);
  const results = await searchBravoArticles(query);
  if (results === null) {
    log(row, `old=${oldArticleId} skip=search_failed`);
    return null;
  }

  const choice = chooseReplacement(evidence, results);
  if (choice.status !== "candidate") {
    log(
      row,
      `old=${oldArticleId} skip=${choice.status}` +
        (choice.status === "ambiguous" ? ` candidates=${choice.articleIds.join(",")}` : "")
    );
    return null;
  }

  // The search summary has no barcodes; the article itself does.
  const article = (await getBravoArticle(choice.article.idArticulo)) ?? choice.article;
  const decision = decideReplacement(
    evidence,
    article,
    await linkedToAnotherProduct(row.productId, article.idArticulo)
  );
  if (!decision.accept) {
    log(row, `old=${oldArticleId} new=${article.idArticulo} skip=${decision.reason} name="${article.nombreArticulo}"`);
    return null;
  }

  const api = bravoArticleApi(article.idArticulo);
  const result = await scrapeBravoPrice({
    shopId: BRAVO_SHOP_ID,
    url: row.url,
    api,
    locationId: row.locationId,
    presentation: row.presentation,
    purchaseMode: row.purchaseMode,
    purchaseUnit: row.purchaseUnit,
  });
  if (result.status !== "ok") {
    log(row, `old=${oldArticleId} new=${article.idArticulo} skip=new_article_${result.reason}`);
    return null;
  }

  const updated = await db
    .update(productsShopsPrices)
    .set({ api })
    .where(
      and(
        eq(productsShopsPrices.productId, row.productId),
        eq(productsShopsPrices.shopId, BRAVO_SHOP_ID),
        eq(productsShopsPrices.api, row.api!)
      )
    )
    .returning({ productId: productsShopsPrices.productId });
  if (updated.length === 0) {
    log(row, `old=${oldArticleId} new=${article.idArticulo} skip=offer_changed_meanwhile`);
    return null;
  }

  log(
    row,
    `old=${oldArticleId} new=${article.idArticulo} code=${article.idexternoArticulo} reason=${decision.reason} name="${article.nombreArticulo}"`
  );
  return { api, result };
}
