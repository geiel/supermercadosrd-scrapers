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
- Drizzle + Postgres DB integration
- DB update behavior aligned with `supermercados-rd` jobs:
  - `products_shops_prices` read/update
  - `products_prices_history` inserts when price changes
  - hide/show logic for unavailable products
  - optional product revalidation endpoint call
- Two production jobs exposed as GitHub `workflow_dispatch`:
  - `scrape:prices-batch` (recommended cadence: every 15 minutes)
  - `scrape:recover-hidden-products` (recommended cadence: every 6-12 hours)
  - `scrape:broken-images-batch` (recommended cadence: every 30-60 minutes)
  - `scrape:deals` (recommended cadence: every 3 hours)

## Required environment variables

- `DATABASE_URL`

Optional:

- `POSTGRES_MAX_CONNECTIONS`
- `REVALIDATE_BASE_URL`
- `REVALIDATION_SECRET`

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

## Job 4: Broken Images Batch (recommended every 30-60 min)

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
- Re-fetches candidate images from each linked supermarket using the same shop-specific extractors used by the main project
- If it finds a different image, it updates `products.image`, updates `product_images.primary`, and deletes the related rows from `product_broken_images`

## GitHub Actions workflows

- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-prices-batch.yml`
- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-deals.yml`
- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-recover-hidden-products.yml`
  - All are `workflow_dispatch` only (no internal cron schedule)

These workflows expect `DATABASE_URL` in repository secrets.

## Notes

- This project intentionally excludes admin/business UI logic.
- Jumbo uses browser automation to bypass Cloudflare.
- Bravo is intentionally excluded from hidden-product recovery because the
  normal prices batch already retries hidden Bravo rows by direct `idArticulo`
  API and will unhide them on a successful scrape.
- Hidden product recovery ignores Sirena for now because a stable Sirena `productid`
  is not stored in this project yet.
