# supermercadosrd-scrapers

Standalone public project for Dominican supermarket scraping.

## What this includes

- Price scrapers for:
  - La Sirena (`shopId=1`)
  - Nacional (`shopId=2`)
  - Jumbo (`shopId=3`)
  - Plaza Lama (`shopId=4`)
  - PriceSmart (`shopId=5`)
  - Bravo (`shopId=6`)
  - Merca Jumbo (`shopId=7`, private runtime config required)
- Drizzle + Postgres DB integration
- DB update behavior aligned with `supermercados-rd` jobs:
  - `products_shops_prices` read/update
  - `products_prices_history` inserts when price changes
  - hide/show logic for unavailable products
  - optional product revalidation endpoint call
- Two production jobs exposed as GitHub `workflow_dispatch`:
  - `scrape:prices-batch` (recommended cadence: every 15 minutes)
  - `scrape:sync-nacional-catalog` (recommended cadence: every 6-12 hours)
  - `scrape:sync-sirena-catalog` (recommended cadence: every 6-12 hours)
  - `scrape:recover-hidden-products` (recommended cadence: every 6-12 hours)
  - `scrape:broken-images-batch` (recommended cadence: every 30-60 minutes)
  - `scrape:deals` (recommended cadence: every 3 hours)

## Required environment variables

- `DATABASE_URL`

Optional:

- `POSTGRES_MAX_CONNECTIONS`
- `REVALIDATE_BASE_URL`
- `REVALIDATION_SECRET`
- `MERCA_JUMBO_API_URL`
- `MERCA_JUMBO_STORE_CODE`

`Merca Jumbo` uses a private Nacional store view. This public repo intentionally
reads its runtime identifiers from environment variables instead of committing
them into source control. If the DB row already contains the GraphQL `api`, only
`MERCA_JUMBO_STORE_CODE` is required at runtime.

## Install

```bash
pnpm install
pnpm build
```

## Job 1: Prices Batch (recommended every 15 min)

```bash
pnpm scrape:prices-batch
```

Defaults:

- `--iterations 80`
- `--urls-per-shop 5`
- `--delay-min 600`
- `--delay-max 1200`
- `--timeout 10000`
- `--retries 3`

Behavior:

- Iteration loop (`1..80`)
- In each iteration, fetch up to `5` stale URLs per shop from DB
- Round loop inside each iteration:
  - Round 1: first URL from each shop in parallel
  - Round 2: second URL from each shop in parallel
  - ...
- Saves price updates directly to DB

## Job 2: Deals (recommended every 3 hours)

```bash
pnpm scrape:deals
```

Behavior:

- Reads deal products from `todays_deals`
- Gets all related `products_shops_prices`
- Runs round-robin per shop
- Saves updates directly to DB
- Executes `SELECT public.refresh_todays_deals()` at the end

## Job 3: Hidden Product Recovery (recommended every 6-12 hours)

```bash
pnpm scrape:recover-hidden-products
```

Defaults:

- `--products-per-shop 5`
- `--delay-min 600`
- `--delay-max 1200`
- `--timeout 10000`
- `--retries 3`
- optional `--shop-id 2,3,4` filter to limit the recovery run to specific shops

Behavior:

- Auto-creates two review-oriented tables if they do not exist yet:
  - `product_shop_recovery_keys`
  - `product_shop_recovery_reviews`
- Reads hidden rows from `products_shops_prices`
- Only targets shops with a stable public recovery key today:
  - Nacional: `sku`
  - Jumbo: numeric URL tail
  - Plaza Lama: `sku`
- Tries to recover the latest working URL/API using the stored external ID
- Verifies the recovered candidate by scraping it again
- Writes the result into `product_shop_recovery_reviews`
- Does not update `products_shops_prices` directly

## Job 4: Nacional Catalog Sync (recommended every 6-12 hours)

```bash
pnpm scrape:sync-nacional-catalog
```

Defaults:

- `--limit 200`
- `--concurrency 6`
- `--retry-hours 24`
- `--delay-min 300`
- `--delay-max 800`
- `--timeout 15000`
- `--retries 3`
- `--rest-batch-size 25`

Behavior:

- Auto-creates one operational table if it does not exist yet:
  - `nacional_catalog_sync_state`
- Reads Nacional's live sitemap and diffs entries by SKU + `lastmod`
- Enriches changed SKUs through Nacional's public Magento REST lookup
- Matches candidates against existing local products using:
  - existing Nacional references in `products_shops_prices`
  - unique barcodes from `products_global_ids`
- Writes review proposals into `product_shop_recovery_reviews`
- These proposals are intended for `/admin/product-recovery-reviews` in the main app
- Does not auto-apply URL changes directly

## Job 5: Broken Images Batch (recommended every 30-60 min)

## Job 5: Sirena Catalog Sync (recommended every 6-12 hours)

```bash
pnpm scrape:sync-sirena-catalog
```

Defaults:

- `--limit 200`
- `--retry-hours 24`
- `--delay-min 300`
- `--delay-max 800`
- `--timeout 15000`
- `--retries 3`
- `--page-size 100`

Behavior:

- Auto-creates one operational table if it does not exist yet:
  - `sirena_catalog_sync_state`
- Reads Sirena's live category tree from `product/categories`
- Crawls paginated top-level category feeds and dedupes by Sirena `productid`
- Logs category/page crawl progress while discovery is running
- Ignores products under `hogar-y-electrodomesticos` and `ropa`, except
  battery-like exceptions such as Duracell/Energizer/Rayovac products
- Matches candidates against existing local products using:
  - existing Sirena references in `products_shops_prices`
  - previously learned Sirena recovery keys by `productid`
- Verifies matched candidates through Sirena's product detail API
- Writes review proposals into `product_shop_recovery_reviews`
- Records unresolved items in `sirena_catalog_sync_state` so they can be
  reviewed from the shared catalog intake flow in the main app
- Does not auto-apply URL changes directly

## Job 6: Broken Images Batch (recommended every 30-60 min)

```bash
pnpm scrape:broken-images-batch
```

Defaults:

- `--iterations 40`
- `--products-per-iteration 5`
- `--concurrency 2`
- `--delay-min 600`
- `--delay-max 1200`
- `--timeout 12000`
- `--retries 3`

Behavior:

- Reads unresolved rows from `product_broken_images`
- Resolves the current primary image from `product_images` or `products.image`
- Verifies the reported image is still broken before replacing it; stale reports
  are deleted without changing the product image set
- Re-fetches candidate images from each linked supermarket using the same shop-specific extractors used by the main project
- If it finds a different image, it updates `products.image`, updates `product_images.primary`, and deletes the related rows from `product_broken_images`

### One-off repair: Bravo second images

```bash
pnpm scrape:revert-bravo-second-images
```

Restores historical Bravo `_2` image rows that were mistakenly replaced by
Bravo `_1` rows, but only when the original `_2` URL still loads. Use
`--dry-run` to inspect the restore/remove pairs without writing changes.

## GitHub Actions workflows

- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-prices-batch.yml`
- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-deals.yml`
- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-recover-hidden-products.yml`
- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-sync-nacional-catalog.yml`
- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-sync-sirena-catalog.yml`
  - All are `workflow_dispatch` only (no internal cron schedule)

These workflows expect `DATABASE_URL` in repository secrets.

## Notes

- This project intentionally excludes admin/business UI logic.
- Jumbo uses browser automation to bypass Cloudflare.
- Merca Jumbo support is wired through private runtime config so the public repo
  does not expose the underlying Nacional store-view identifiers.
- Bravo is intentionally excluded from hidden-product recovery because the
  normal prices batch already retries hidden Bravo rows by direct `idArticulo`
  API and will unhide them on a successful scrape.
- Hidden product recovery ignores Sirena for now because a stable Sirena `productid`
  is not stored in this project yet.
- Nacional catalog sync only creates review proposals for products that can be
  matched to an existing app product. Unmatched catalog items are recorded in
  sync state but are not reviewable from the admin page yet.
- Sirena catalog sync stores unresolved items in `sirena_catalog_sync_state`
  and exposes them through the same intake review flow used for Nacional.
