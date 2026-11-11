import assert from "node:assert/strict";
import test from "node:test";

import {
  bravoArticleIdFromApi,
  bravoCodesFromImageUrls,
  bravoSearchQuery,
  chooseReplacement,
  decideReplacement,
  parseSizes,
  type BravoArticle,
  type BravoRelinkEvidence,
} from "./bravo-relink.js";

function evidence(overrides: Partial<BravoRelinkEvidence>): BravoRelinkEvidence {
  return {
    oldArticleId: 1,
    codes: [],
    previousBravoName: null,
    previousPurchaseType: null,
    purchaseMode: "unit",
    productName: null,
    presentation: null,
    globalIds: [],
    ...overrides,
  };
}

function article(overrides: Partial<BravoArticle>): BravoArticle {
  return {
    idArticulo: 2,
    idexternoArticulo: "0",
    nombreArticulo: "",
    idTipounidadArticulo: 1,
    eans: [],
    ...overrides,
  };
}

// Product 7027, 2026-11-11: Bravo moved it from 26343 to 32493.
const cremaBatida = evidence({
  oldArticleId: 26343,
  codes: bravoCodesFromImageUrls([
    "https://bravova-resources.superbravo.com.do/images/catalogo/big/97235_1.png?v=0",
  ]),
  productName: "Bravo Crema Batida Spray",
  presentation: "250 GR",
});

test("reads Bravo codes from image URLs and the article id from the api", () => {
  assert.deepEqual(cremaBatida.codes, ["97235"]);
  assert.equal(
    bravoArticleIdFromApi("https://bravova-api.superbravo.com.do/public/articulo/get?idArticulo=26343"),
    26343
  );
  assert.equal(bravoArticleIdFromApi("https://bravova.superbravo.com.do"), null);
});

test("finds the re-listed article by Bravo's product code", () => {
  const choice = chooseReplacement(cremaBatida, [
    article({ idArticulo: 31000, idexternoArticulo: "11111", nombreArticulo: "RICA CREMA BATIDA 250 GR" }),
    article({ idArticulo: 32493, idexternoArticulo: "97235", nombreArticulo: "BRAVO CREMA BATIDA SPRAY 250 GR" }),
  ]);
  assert.equal(choice.status, "candidate");
  assert.equal(choice.status === "candidate" && choice.article.idArticulo, 32493);
  assert.deepEqual(
    decideReplacement(cremaBatida, article({ idArticulo: 32493, idexternoArticulo: "97235", nombreArticulo: "BRAVO CREMA BATIDA SPRAY 250 GR" }), false),
    { accept: true, reason: "same_code" }
  );
});

test("ignores the old article and refuses two articles with the same code", () => {
  assert.equal(
    chooseReplacement(cremaBatida, [article({ idArticulo: 26343, idexternoArticulo: "97235" })]).status,
    "none"
  );
  assert.deepEqual(
    chooseReplacement(cremaBatida, [
      article({ idArticulo: 32493, idexternoArticulo: "97235" }),
      article({ idArticulo: 32494, idexternoArticulo: "097235" }),
    ]),
    { status: "ambiguous", articleIds: [32493, 32494] }
  );
});

test("never takes an article another product already uses (Chocoleche 3 pack → single)", () => {
  const decision = decideReplacement(
    evidence({ codes: ["91527"], presentation: "200 ML" }),
    article({ idArticulo: 30691, idexternoArticulo: "91527", nombreArticulo: "BRAVO CHOCOLECHE 200 ML" }),
    true
  );
  assert.deepEqual(decision, { accept: false, reason: "article_linked_to_another_product" });
});

test("a size that differs from our product needs a matching barcode (Limppano 100 → 80 g)", () => {
  const decision = decideReplacement(
    evidence({ codes: ["15883"], presentation: "100 GR" }),
    article({ idArticulo: 31371, idexternoArticulo: "15883", nombreArticulo: "LIMPPANO DESHUMIDIF INSP FLORAL 80 GR", eans: ["7896021625123"] }),
    false
  );
  assert.deepEqual(decision, { accept: false, reason: "size_differs_from_product" });
});

test("a matching barcode settles a size written differently (Act II 91 g vs 3 oz)", () => {
  const decision = decideReplacement(
    evidence({ codes: ["54098"], presentation: "91 GR", globalIds: ["76150601336", "76150200393"] }),
    article({
      idArticulo: 31399,
      idexternoArticulo: "54098",
      nombreArticulo: "ACT II POP CORN BUTTER 18/3 OZ",
      eans: ["076150219999", "076150601336"],
    }),
    false
  );
  assert.deepEqual(decision, { accept: true, reason: "same_code_and_barcode" });
});

test("compares with Bravo's old name first, since its sizes can be wrong but stable (Vini Lady 190 ml)", () => {
  const next = article({ idArticulo: 31396, idexternoArticulo: "87819", nombreArticulo: "VINI LADY SHAMPOO ANTI CASPA 190 ML" });
  assert.equal(
    decideReplacement(
      evidence({ codes: ["87819"], presentation: "200 ML", previousBravoName: "VINI LADY SHAMPOO ANTI CASPA 190 ML" }),
      next,
      false
    ).accept,
    true
  );
  assert.equal(decideReplacement(evidence({ codes: ["87819"], presentation: "200 ML" }), next, false).accept, false);
});

test("reads ounces as weight or fluid volume", () => {
  const motts = decideReplacement(
    evidence({ codes: ["16215"], presentation: "296 ML" }),
    article({ idArticulo: 32201, idexternoArticulo: "16215", nombreArticulo: "MOTTS APPLE JUICE 10 OZ" }),
    false
  );
  assert.equal(motts.accept, true);
  assert.equal(parseSizes("GLADE AEROSOL VAINILLA 8OZ").length, 2);
  assert.deepEqual(parseSizes("CEBOLLA BLANCA LB"), []);
});

test("a change between unit and weight sale needs a matching barcode", () => {
  const next = article({ idArticulo: 31949, idexternoArticulo: "96704", nombreArticulo: "POLLO ENTERO CONG IMPORTADO", idTipounidadArticulo: 2 });
  assert.equal(
    decideReplacement(evidence({ codes: ["96704"], presentation: "1 LB", purchaseMode: null }), next, false).accept,
    true
  );
  assert.deepEqual(
    decideReplacement(evidence({ codes: ["96704"], presentation: "1 LB", purchaseMode: "unit" }), next, false),
    { accept: false, reason: "purchase_type_changed" }
  );
});

test("searches with Bravo's own old name when it was recorded", () => {
  assert.equal(bravoSearchQuery(cremaBatida), "Bravo Crema Batida Spray");
  assert.equal(
    bravoSearchQuery(evidence({ productName: "x", previousBravoName: "GUANDY MARSH. BICOLOR 100GR" })),
    "GUANDY MARSH BICOLOR 100GR"
  );
  // Without filler words Bravo ranks LA REAL TORTILLAS MEXICANAS in its first page.
  assert.equal(
    bravoSearchQuery(evidence({ productName: "Tortilla De Maíz Taco La Real" })),
    "Tortilla Maiz Taco Real"
  );
});
