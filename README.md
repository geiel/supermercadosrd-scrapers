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
