import assert from "node:assert/strict";
import test from "node:test";

import {
  isPositivePrice,
  isVisibleRitmoStatus,
  parseRitmoPriceCsv,
} from "./ritmo/price-csv.js";
import { isRitmoProductCatalogFilename } from "./ritmo/sftp.js";

test("parses Ritmo Estado from the product catalog", () => {
  const parsed = parseRitmoPriceCsv(
    [
      "SKU,Descripcion,Codigo de Barras,Precio,Marca,Estado,Producto Nuevo",
      "00001,Producto activo,1234567890123,34.00,Marca,Activo,No",
      "00002,Producto temporada,1234567890124,50.00,Marca,Temporada,No",
      "00003,Producto descontinuado,1234567890125,75.00,Marca,Descontinuado,No",
    ].join("\n")
  );

  assert.deepEqual(
    parsed.rows.map((row) => ({ sku: row.sku, status: row.status })),
    [
      { sku: "00001", status: "Activo" },
      { sku: "00002", status: "Temporada" },
      { sku: "00003", status: "Descontinuado" },
    ]
  );
});

test("only Activo and Temporada are visible Ritmo statuses", () => {
  assert.equal(isVisibleRitmoStatus("Activo"), true);
  assert.equal(isVisibleRitmoStatus(" temporada "), true);
  assert.equal(isVisibleRitmoStatus("Descontinuado"), false);
  assert.equal(isVisibleRitmoStatus("Inactivo"), false);
  assert.equal(isVisibleRitmoStatus(null), false);
});

test("requires Estado in the Ritmo price catalog", () => {
  assert.throws(
    () =>
      parseRitmoPriceCsv(
        "SKU,Descripcion,Precio,Marca\n00001,Producto,34.00,Marca"
      ),
    /status column/
  );
});

test("visibility requires both an allowed status and a positive price", () => {
  assert.equal(isVisibleRitmoStatus("Activo") && isPositivePrice("10"), true);
  assert.equal(isVisibleRitmoStatus("Temporada") && isPositivePrice("10"), true);
  assert.equal(isVisibleRitmoStatus("Activo") && isPositivePrice("0"), false);
  assert.equal(
    isVisibleRitmoStatus("Descontinuado") && isPositivePrice("10"),
    false
  );
});

test("automatic Ritmo SFTP selection only accepts Catalogo_Productos CSVs", () => {
  assert.equal(
    isRitmoProductCatalogFilename(
      "Catalogo_Productos_PROD_NC44_20260807.csv"
    ),
    true
  );
  assert.equal(
    isRitmoProductCatalogFilename("Catalogo_Nuevos_PROD_NC44_20260807.csv"),
    false
  );
  assert.equal(isRitmoProductCatalogFilename("otro.csv"), false);
});
