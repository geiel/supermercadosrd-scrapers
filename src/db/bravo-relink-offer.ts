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
  selectBravoCodes,
  type BravoRelinkEvidence,
} from "../bravo-relink.js";
import { bravoPriceFromPayload, getBravoArticle, searchBravoArticles } from "../shops/bravo.js";
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

export type BravoRelinkOutcome =
  /** The offer now points at the new article; apply this price to it. */
  | { status: "relinked"; api: string; result: ScrapePriceSuccess }
  /** Someone else changed the offer meanwhile; leave it alone. */
  | { status: "offer_changed" }
  /** No certain replacement; the caller hides the offer as before. */
  | { status: "not_relinked" };

const NOT_RELINKED: BravoRelinkOutcome = { status: "not_relinked" };

function log(row: RelinkRow, message: string) {
  console.log(`[RELINK] bravo productId=${row.productId} ${message}`);
}

async function loadEvidence(row: RelinkRow, oldArticleId: number): Promise<BravoRelinkEvidence | null> {
  const rows = await db.execute<{
    name: string | null;
    image: string | null;
    visibleImages: string[] | null;
    hiddenImages: string[] | null;
    globalIds: string[] | null;
    evidence: Record<string, unknown> | null;
  }>(sql`
    select p.name, p.image,
      (select json_agg(i."imageUrl") from product_images i where i."productId" = p.id and not i.hidden) as "visibleImages",
      (select json_agg(i."imageUrl") from product_images i where i."productId" = p.id and i.hidden) as "hiddenImages",
      (select json_agg(g.value) from products_global_ids g where g."productId" = p.id) as "globalIds",
      x."purchaseTermsEvidence" as "evidence"
    from products p
    join products_shops_prices x on x."productId" = p.id and x."shopId" = ${BRAVO_SHOP_ID}
    where p.id = ${row.productId}
  `);
  const record = rows[0];
  if (!record) return null;

  const evidence = record.evidence ?? {};
  // What the price job recorded counts only for the article that just failed,
  // and then it is the only code used.
  const recordedForOldArticle = Number(evidence.idArticulo) === oldArticleId;
  const { codes, codeSource } = selectBravoCodes({
    recordedCode:
      recordedForOldArticle && evidence.idexternoArticulo != null
        ? String(evidence.idexternoArticulo)
        : null,
    visibleImageCodes: bravoCodesFromImageUrls([record.image, ...(record.visibleImages ?? [])]),
    hiddenImageCodes: bravoCodesFromImageUrls(record.hiddenImages ?? []),
  });
  const previousType = Number(evidence.idTipounidadArticulo);

  return {
    oldArticleId,
    codes,
    codeSource,
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

type Executor = Pick<typeof db, "execute">;

async function articleOnAnotherProduct(client: Executor, productId: number, articleId: number) {
  const rows = await client.execute(sql`
    select 1 from products_shops_prices
    where "shopId" = ${BRAVO_SHOP_ID} and "productId" <> ${productId}
      and substring(api from '[?&]idArticulo=([0-9]+)(&|$)') = ${String(articleId)}
    limit 1
  `);
  return rows.length > 0;
}

/**
 * Called when Bravo answers that the offer's article no longer exists. Looks for
 * the same product under a new idArticulo and, when it is certain, points the
 * offer at it.
 */
export async function relinkBravoOffer(row: RelinkRow): Promise<BravoRelinkOutcome> {
  if (row.shopId !== BRAVO_SHOP_ID || !row.api) return NOT_RELINKED;
  const oldApi = row.api;
  const oldArticleId = bravoArticleIdFromApi(oldApi);
  if (oldArticleId === null) return NOT_RELINKED;

  const evidence = await loadEvidence(row, oldArticleId);
  if (!evidence || evidence.codes.length === 0) {
    log(row, `old=${oldArticleId} skip=no_bravo_code`);
    return NOT_RELINKED;
  }

  const results = await searchBravoArticles(bravoSearchQuery(evidence));
  if (results === null) {
    log(row, `old=${oldArticleId} skip=search_failed`);
    return NOT_RELINKED;
  }

  const choice = chooseReplacement(evidence, results);
  if (choice.status !== "candidate") {
    log(
      row,
      `old=${oldArticleId} skip=${choice.status}` +
        (choice.status === "ambiguous" ? ` candidates=${choice.articleIds.join(",")}` : "")
    );
    return NOT_RELINKED;
  }

  // The search summary has no barcodes or prices; the article itself has both.
  const fetched = await getBravoArticle(choice.article.idArticulo);
  if (!fetched || fetched.article.idArticulo !== choice.article.idArticulo) {
    log(row, `old=${oldArticleId} new=${choice.article.idArticulo} skip=article_fetch_failed`);
    return NOT_RELINKED;
  }
  const article = fetched.article;
  const newArticleId = article.idArticulo;

  const decision = decideReplacement(
    evidence,
    article,
    await articleOnAnotherProduct(db, row.productId, newArticleId)
  );
  if (!decision.accept) {
    log(row, `old=${oldArticleId} new=${newArticleId} skip=${decision.reason} name="${article.nombreArticulo}"`);
    return NOT_RELINKED;
  }

  const api = bravoArticleApi(newArticleId);
  const result = bravoPriceFromPayload(fetched.payload, {
    shopId: BRAVO_SHOP_ID,
    url: row.url,
    api,
    locationId: row.locationId,
    presentation: row.presentation,
    purchaseMode: row.purchaseMode,
    purchaseUnit: row.purchaseUnit,
  });
  if (result.status !== "ok") {
    log(row, `old=${oldArticleId} new=${newArticleId} skip=new_article_${result.reason}`);
    return NOT_RELINKED;
  }

  // One article, one product: serialize claims on the article and check again
  // inside the transaction before switching the offer.
  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BRAVO_SHOP_ID}::int, ${newArticleId}::int)`);
    if (await articleOnAnotherProduct(tx, row.productId, newArticleId)) {
      return "article_claimed" as const;
    }
    const updated = await tx
      .update(productsShopsPrices)
      .set({ api })
      .where(
        and(
          eq(productsShopsPrices.productId, row.productId),
          eq(productsShopsPrices.shopId, BRAVO_SHOP_ID),
          eq(productsShopsPrices.api, oldApi)
        )
      )
      .returning({ productId: productsShopsPrices.productId });
    return updated.length > 0 ? ("claimed" as const) : ("offer_changed" as const);
  });

  if (claim === "offer_changed") {
    log(row, `old=${oldArticleId} new=${newArticleId} skip=offer_changed_meanwhile`);
    return { status: "offer_changed" };
  }
  if (claim === "article_claimed") {
    log(row, `old=${oldArticleId} new=${newArticleId} skip=article_linked_to_another_product`);
    return NOT_RELINKED;
  }

  log(
    row,
    `old=${oldArticleId} new=${newArticleId} code=${article.idexternoArticulo} reason=${decision.reason} name="${article.nombreArticulo}"`
  );
  return { status: "relinked", api, result };
}
