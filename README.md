# Some scrappers

## Normalized product measurements

The production jobs require the app migration `0139_remove_product_unit_columns`.
`ScrapePriceInput.presentation` is a read-only, compact label obtained from
`product_measurement_label(productId)`. It is optional; jobs no longer read
product unit columns. The existing offer's `purchaseMode` and `purchaseUnit`
remain separate inputs, so a one-pound package is not mistaken for a per-pound
sale. Ambiguous source data preserves existing purchase terms.

PriceSmart returns `productMeasurementUpdate` with `declaredUnit`,
`declaredQuantity` and `canonicalQuantity`. Its writer resolves the semantic type
through `measurement_types` and records retailer observations as `inferred`.
It preserves existing quantities and review states, does not reactivate rejected
facts, and does not redefine a shared product or overwrite conflicting verified
content. Repeated observations do not add duplicate measurements.

Deploy the updated app, this package and the database migration in a coordinated
maintenance window. Stop old jobs before removing columns and restart only the
updated revisions afterward. Organizer and PriceRD are outside this transition.

## Supermix price sync

`pnpm scrape:sync-supermix-prices` refreshes every Supermix price (`shopId=14`)
through the public JSON API of Supermix's Vendabo storefront (Supermix left
Shopify on 2026-10-07). It pages through the whole catalog, 100 products per
request (~210 requests, 1.5–3 s apart), then looks up one by one only the
visible rows missing from the listing (at most 300 per run). It runs in its own
workflow every 6 hours and does not use the shared prices batch. `api` holds
the Supermix product id, or `<productId>:<variantId>` for a product that groups
several variants (sizes, colors) with their own prices; each such product costs
one extra request per run. Rows that only have a `/p/<slug>` URL get their id
saved on the next run. Shopify-era `/products/<handle>` links are never matched
by slug (many handles now point to another product): they are hidden until
someone links them again. No secrets are needed.

The run fails, so GitHub sends a notification, when a request fails, a product
needs attention (for example `multiple_variants`), or a visible Supermix price
is older than 12 hours. Use `--dry-run` to fetch prices without writing, and
`--product-id` or `--limit` for partial runs.

## Olé price sync

`pnpm scrape:sync-ole-prices` refreshes every Hipermercados Olé price
(`shopId=15`) through the catalog API behind Olé's app "Ole en Casa"
(nopCommerce Web API Frontend at `ecommerce.hiperole.com.do/api-frontend`;
Olé agreed to it on 2026-10-19). The catalog endpoints need no token. It pages
through the 33 root categories with the largest page size each category offers
(75, or 9 in "Nuestras Marcas" and the cookie categories), about 170 requests
1–1.5 s apart, then looks up one by one only the rows missing from the listing
(at most 300 per run). It runs in its own workflow every 6 hours and does not
use the shared prices batch. `api` holds the Olé product id. No secrets are
needed.

`price_value` is the current price and a higher `old_price_value` the regular
price. Products with `disable_buy_button` cannot be ordered (Olé does not
manage stock, so `in_stock` is always true) and are hidden. Products sold by
the pound ("Chuleta Ahumada Lb") get measure purchase terms in pounds from the
product details (the quantities the app lets a shopper pick); this costs one
extra request the first time such a link is priced. If the listing comes back
with fewer than 5,000 products (5,920 on 2026-10-19), rows missing from it are
looked up instead of hidden, and the run fails.

The run fails, so GitHub sends a notification, when a request fails, a product
needs attention, or a visible Olé price is older than 12 hours. Use
`--dry-run` to fetch prices without writing, and `--product-id` or `--limit`
for partial runs.

## Batch price sync

`pnpm scrape:sync-batch-prices` refreshes every Sirena (`shopId=1`), Nacional
(2), Jumbo (3) and Merca Jumbo (7) price with batched lookups: one request
prices up to 50 products, where the per-product batch spent one request per
row. It runs every 2 hours, dispatched by the Supabase cron job "Refresh Batch
Prices" (`net.http_post` to the workflow's dispatches endpoint), like the other
scrapers.

- Sirena: VTEX search with repeated `fq` filters. A slug API
  (`.../search/linda-habichuela-blanca-15-oz-1027594/p`) is looked up by
  `alternateIds_RefId` (the digits that end the slug), and the product only
  counts when its `linkText` is that slug. An `fq=productId:<id>` API is looked
  up by product id. Rows on the old `st.sirena.do` API, or on an EAN API, stay
  in the per-product batch.
- Nacional: GraphQL (store `default`) `final_price`, the price the Nacional
  website shows and charges, as for Jumbo and Merca Jumbo. The REST lookup's
  rule (`special_price` while `special_from_date`/`special_to_date` allow it)
  is not used: on 2026-11-01 Nacional still charged offers whose end date had
  passed, and the dates read in UTC end offers 4 hours early. GraphQL only
  lists products enabled on the Nacional website, so a SKU it leaves out is
  looked up through REST, which decides whether to hide.
- Jumbo and Merca Jumbo: GraphQL `products(filter: { sku: { in: [...] } })`
  with the fields of the single lookup. Jumbo's SKU candidates (the `998`
  prefix) are tried in the same order.

Both Magento lookups, single and batched, ask for `peso_variable` directly.
Through `custom_attributesV2` Magento answered "Internal server error" for
many products (checked on 2026-10-31, one product or fifty), so the purchase
terms were worked out without the flag; on a batch of 50 that field also took
~7 s instead of ~1 s. With the flag, a 25 lb sack of chestnuts is one unit and
not "minimum 25", and a bag of carrots is a unit and not sold by the pound.

A dry run on 2026-10-31 priced 44,834 rows with 898 batch requests and 55
single lookups in about 35 minutes; the per-product batch and the deals job
had been sending ~64,000 requests a day for these shops.

Nacional, Merca Jumbo and Jumbo share one Magento backend, so they share one
queue; Sirena has its own. Each queue sends one request at a time, 1–1.5 s
apart, and stops asking a backend for the rest of the run after an HTTP 403,
429 or 503 (after retries) or three failures in a row.

Visible rows are priced on every run, oldest first. A visible row a good
response leaves out is looked up with the single scraper (at most 300 per shop
and run), so a price is hidden on the same evidence as before. A request that
fails for another reason is split in two and each half asked again, down to
single rows: one product that breaks the store's query (on 2026-11-02 Nacional,
Jumbo and Merca Jumbo answered "Internal server error" for any batch holding
SKU 2235195) then fails only its own row, which keeps its stored price, and a
passing VTEX HTTP 500 is retried in halves. Splitting costs ~10 requests per
broken product and stops after 50 split requests per shop and run
(`--max-split-requests`), so a backend that fails everything without a 503
gets at most ~53 requests before the run stops and fails, instead of being
asked row by row. Rows without a SKU in their URL get the single scraper's
error without a request. Hidden rows are
rechecked once a day; one that is still unavailable only gets `updateAt`
moved, without a page revalidation.

The rows this job owns (`batchPriceRowCondition` in `src/batch-price-sync.ts`)
are skipped by the routine per-product batch and by the deals job. A
per-product run for `--product-id` or `--shop-id` still prices any row.

The run fails, so GitHub sends a notification, when a backend is stopped, the
lookup limit is reached, more than 25 products could not be priced, or more
than 25 visible prices are older than 6 hours. Fewer are listed in the run
summary without failing it (`--max-row-failures`, `--max-stale`). Use `--dry-run` to fetch prices without writing (`--report <file>`
writes one JSON line per row), and `--shop-id`, `--product-id` or `--limit`
(rows per shop) for partial runs.

## Per-product prices batch

`pnpm scrape:prices-batch` prices the remaining shops one product at a time,
every hour, at most 400 rows per shop and run (80 iterations of 5). A row that
fails without being hidden keeps its `updateAt`, so it is skipped for the rest
of the run instead of coming back first in every iteration.
