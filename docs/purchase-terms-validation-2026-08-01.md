# Purchase terms validation — 2026-08-01

## Scope

Read-only validation of `purchaseMode`, `purchaseUnit`, minimum, increment,
maximum, price reference quantity, and their agreement with product metadata.
The final scraper code was exercised against 38 distinct product/shop pairs with
HTTP 200 responses across Sirena, Nacional, Jumbo, Merca Jumbo, Plaza Lama,
PriceSmart, Bravo, Garrido, and Carrefour.

No database writes or backfill were performed during this validation.

## Corrections

- Carrefour uses a bare catalog measure such as `LB` only as measured sale.
  Explicit package content such as `450 GR` or `1 KG` is normalized to
  `unit/UND`; Typesense only supplies unit-count limits.
- Garrido ignores blank `subUnit`, falls back to the API `unit`, and preserves
  fractional `clickMultiplier` as the measured purchase increment. A source
  measure that conflicts with the product package is downgraded to whole-unit
  purchase.
- Magento treats a fractional minimum/increment plus matching `1 LB` metadata as
  measured sale even when `custom_attributesV2` is missing. Explicit API measure
  flags that conflict with fixed package metadata are cleared.
- Sirena uses the VTEX item label as a cross-check. It corrects the known
  `unitMultiplier=100` / `1 LB` contradiction and rejects measured terms when
  the item label says `1 Und.`.
- The shared builder rejects fractional minimum or increment values for
  `unit/UND` rules and rejects mode/unit mismatches.

## Representative live checks

| Retailer | Product | API evidence | Final normalization |
| --- | ---: | --- | --- |
| Carrefour | 493 | `minPurchase=1`, package `450 G` | `unit/UND`, min 1, step 1 |
| Carrefour | 406 | bare catalog `LB` | `measure/LB`, min 1, step 1 |
| Garrido | 3180 | `unit=LB`, blank `subUnit`, click 0.5 | `measure/LB`, min 0.5, step 0.5 |
| Garrido | 3720 | `unit=LB`, click 0.75 | `measure/LB`, min 0.75, step 0.75 |
| Garrido | 27529 | API `LB`, product `1 GL` | `unit/UND` |
| Sirena | 2679 | multiplier 100, item label `1 LB` | `measure/LB`, min 1, step 1 |
| Sirena | 4959 | API `LB`, item label `1 Und.`, product `7 OZ` | standard unit (`null`) |
| Nacional/Jumbo/Merca Jumbo | 878 | label `lb`, min/step 0.5, product `1 LB` | `measure/LB`, min 0.5, step 0.5 |
| Nacional | 3278 | API `LB`, product `8 KG` package | standard unit (`null`) |
| Nacional | 3526 | API `LB`, product `6 OZ` package | standard unit (`null`) |
| PriceSmart | 1683 | sold by weight, actual piece weight and total price | standard unit (`null`) |
| Bravo | 1746 | explicit purchase type 2 | `measure/LB`, min 2, step 2 |
| Plaza Lama | 493 | explicit `UND`, blank `subUnit` | `unit/UND`, min 1, step 1 |

PriceSmart's `sold_by_weight` describes variable-weight pieces whose `unit_price`
is already the total for the selected piece. The generic min/max weight
attributes are also present on products with `sold_by_weight=0`; they are not
safe purchase increments and are deliberately ignored.

## Population impact before backfill

The read-only database profile found:

- 1,825 visible Carrefour package offers currently stored as measured sale.
- 156 visible Garrido offers whose API measure agrees with the product metadata
  and should become measured sale.
- 7 visible Garrido offers whose API measure conflicts with the product package
  and should remain whole units.
- 3 Magento offers stored as fractional whole units; all map to measured `LB`.
- 2 Nacional measured rules whose API conflicts with fixed product packages;
  both now normalize to standard unit purchase.

These values describe the current database. They change only after the normal
price scraper runs or an explicitly reviewed backfill is executed.

## Automated verification

`node --import tsx --test $(rg --files src -g '*.test.ts' | sort)` passes all
37 tests. `pnpm typecheck` and `pnpm build` also pass.
