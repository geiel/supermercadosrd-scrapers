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

## GitHub Actions workflows

- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-prices-batch.yml`
- `/Users/geielpeguero/Desktop/Geiel/supermercadosrd-v2/supermercadosrd-scrapers/.github/workflows/scrape-deals.yml`
  - Both are `workflow_dispatch` only (no internal cron schedule)

Both workflows expect `DATABASE_URL` in repository secrets.

## Notes

- This project intentionally excludes admin/business UI logic.
- Jumbo uses browser automation to bypass Cloudflare.
