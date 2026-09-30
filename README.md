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
through the Shopify Storefront API in batches of 250 products, with 3–5 s
between requests. It runs in its own workflow every 6 hours and does not use
the shared prices batch. `api` holds the Shopify Product GID (or a
ProductVariant GID for multi-variant products); rows that only have a product
URL get their GID resolved and saved on the next run.

Required secrets in the `Production` environment:
`SUPERMIX_STOREFRONT_API_URL` and `SUPERMIX_STOREFRONT_ACCESS_TOKEN`.

The run fails, so GitHub sends a notification, when a request fails, a product
needs attention (for example `multiple_variants`), or a visible Supermix price
is older than 12 hours. Use `--dry-run` to fetch prices without writing, and
`--product-id` or `--limit` for partial runs.
