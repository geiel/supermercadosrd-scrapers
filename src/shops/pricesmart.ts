import { z } from "zod";
import { PRICESMART_PRODUCT_API_URL } from "../api-endpoints.js";
import { fetchWithRetry, getPricesmartHeaders } from "../http-client.js";
import {
  PREFERRED_DO_PRICESMART_LOCATION_IDS,
  PRICESMART_DO_DEFAULT_LOCATION_ID,
} from "../pricesmart-locations.js";
import { error, notFound, ok } from "../result.js";
import {
  formatAmount,
  formatUnit,
  parseProductUnit,
  parseUnit,
  type ParsedUnit,
} from "../unit-utils.js";
import type {
  FetchWithRetryConfig,
  ScrapePriceInput,
  ScrapePriceResult,
} from "../types.js";

const shopId = 5;
const SOURCE_UNIT_MATCH_RATIO_THRESHOLD = 0.97;

const responseSchema = z.object({
  data: z.object({
    products: z.object({
      results: z.array(
        z.object({
          masterData: z.object({
            current: z.object({
              allVariants: z.array(
                z.object({
                  attributesRaw: z.array(
                    z.object({
                      name: z.string(),
                      value: z.unknown(),
                    })
                  ),
                })
              ),
            }),
          }),
        })
      ),
    }),
  }),
});

const pricesmartPriceSchema = z.array(
  z.object({
    country: z.string(),
    club: z.string().optional(),
    value: z.string(),
  })
);

const pricesmartLocationAttributeSchema = z.array(
  z.object({
    country: z.string(),
    club: z.string().optional(),
    value: z.unknown(),
  })
);

type PricesmartProductResult = z.infer<
  typeof responseSchema
>["data"]["products"]["results"][number];
type PricesmartLocationAttribute = z.infer<
  typeof pricesmartLocationAttributeSchema
>[number];

type PricesmartLocationCandidate = {
  country: string;
  club?: string;
  currentPrice: string;
  regularPrice?: string;
  available: boolean | null;
  soldByWeight: boolean | null;
  sourceUnit: string | null;
  parsedSourceUnit: ParsedUnit | null;
};

function parsePriceEntries(raw: unknown) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = pricesmartPriceSchema.safeParse(JSON.parse(String(raw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseLocationAttributes(raw: unknown) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = pricesmartLocationAttributeSchema.safeParse(
      JSON.parse(String(raw))
    );
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function getAttributeValue(
  entries: PricesmartLocationAttribute[],
  country: string,
  club: string | undefined
) {
  const entry = entries.find(
    (candidate) => candidate.country === country && candidate.club === club
  );

  if (entry?.value === undefined || entry.value === null) {
    return null;
  }

  return String(entry.value);
}

function getParsedSourceUnit(weight: string | null, weightUnit: string | null) {
  const amount = Number(weight);
  if (!Number.isFinite(amount) || amount <= 0 || !weightUnit) {
    return { sourceUnit: null, parsedSourceUnit: null };
  }

  const sourceUnit = formatUnit(
    `${formatAmount(amount)} ${weightUnit.toUpperCase()}`
  );

  return {
    sourceUnit,
    parsedSourceUnit: parseUnit(sourceUnit),
  };
}

function parseBooleanAttribute(value: string | null) {
  if (value === null) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return null;
}

function buildLocationCandidates({
  productPrice,
  originalPrice,
  weightEntries,
  weightUnitEntries,
  availabilityEntries,
  soldByWeightEntries,
}: {
  productPrice: z.infer<typeof pricesmartPriceSchema>;
  originalPrice: z.infer<typeof pricesmartPriceSchema>;
  weightEntries: PricesmartLocationAttribute[];
  weightUnitEntries: PricesmartLocationAttribute[];
  availabilityEntries: PricesmartLocationAttribute[];
  soldByWeightEntries: PricesmartLocationAttribute[];
}) {
  return productPrice
    .filter((entry) => entry.country === "DO" && Number(entry.value) > 0)
    .map<PricesmartLocationCandidate>((entry) => {
      const regularPrice = originalPrice.find(
        (priceEntry) =>
          priceEntry.country === entry.country &&
          priceEntry.club === entry.club &&
          Number(priceEntry.value) > 0
      );
      const weight = getAttributeValue(weightEntries, entry.country, entry.club);
      const weightUnit = getAttributeValue(
        weightUnitEntries,
        entry.country,
        entry.club
      );
      const rawAvailability = getAttributeValue(
        availabilityEntries,
        entry.country,
        entry.club
      );
      const rawSoldByWeight = getAttributeValue(
        soldByWeightEntries,
        entry.country,
        entry.club
      );

      return {
        country: entry.country,
        club: entry.club,
        currentPrice: entry.value,
        regularPrice: regularPrice?.value,
        available: parseBooleanAttribute(rawAvailability),
        soldByWeight: parseBooleanAttribute(rawSoldByWeight),
        ...getParsedSourceUnit(weight, weightUnit),
      };
    });
}

function getLocationPreferenceRank(club: string | undefined) {
  const preferredIndex = PREFERRED_DO_PRICESMART_LOCATION_IDS.findIndex(
    (locationId) => locationId === club
  );

  if (preferredIndex >= 0) {
    return preferredIndex;
  }

  if (club === PRICESMART_DO_DEFAULT_LOCATION_ID) {
    return PREFERRED_DO_PRICESMART_LOCATION_IDS.length;
  }

  return PREFERRED_DO_PRICESMART_LOCATION_IDS.length + 1;
}

function compareLocationCandidates(
  left: PricesmartLocationCandidate,
  right: PricesmartLocationCandidate
) {
  if (left.available !== right.available) {
    if (left.available === true) return -1;
    if (right.available === true) return 1;
  }

  const leftRank = getLocationPreferenceRank(left.club);
  const rightRank = getLocationPreferenceRank(right.club);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return (left.club ?? "").localeCompare(right.club ?? "");
}

function getPreferredLocationCandidate(candidates: PricesmartLocationCandidate[]) {
  for (const locationId of PREFERRED_DO_PRICESMART_LOCATION_IDS) {
    const preferredEntry = candidates.find(
      (entry) => entry.country === "DO" && entry.club === locationId
    );

    if (preferredEntry) {
      return preferredEntry;
    }
  }

  return candidates.find(
    (entry) =>
      entry.country === "DO" &&
      entry.club === PRICESMART_DO_DEFAULT_LOCATION_ID
  );
}

function unitsAreClose(left: ParsedUnit | null, right: ParsedUnit | null) {
  if (!left || !right || left.measurement !== right.measurement) {
    return false;
  }

  const maxBase = Math.max(left.base, right.base);
  const minBase = Math.min(left.base, right.base);

  if (!Number.isFinite(maxBase) || !Number.isFinite(minBase) || maxBase <= 0) {
    return false;
  }

  return minBase / maxBase >= SOURCE_UNIT_MATCH_RATIO_THRESHOLD;
}

function selectLocationCandidate(
  candidates: PricesmartLocationCandidate[],
  input: ScrapePriceInput
) {
  const parsedProductUnit = parseProductUnit(input);

  if (parsedProductUnit) {
    const unitMatches = candidates
      .filter((candidate) =>
        unitsAreClose(parsedProductUnit, candidate.parsedSourceUnit)
      )
      .sort(compareLocationCandidates);

    if (unitMatches.length > 0) {
      return unitMatches[0];
    }
  }

  return getPreferredLocationCandidate(candidates);
}

function getConsistentSourceUnit(candidates: PricesmartLocationCandidate[]) {
  const candidatesWithSourceUnits = candidates.filter(
    (candidate) => candidate.parsedSourceUnit
  );

  if (candidatesWithSourceUnits.length === 0) {
    return null;
  }

  const reference = candidatesWithSourceUnits[0].parsedSourceUnit;
  if (
    candidatesWithSourceUnits.some(
      (candidate) => !unitsAreClose(reference, candidate.parsedSourceUnit)
    )
  ) {
    return null;
  }

  return candidatesWithSourceUnits[0];
}

function getProductUnitUpdate(
  candidates: PricesmartLocationCandidate[],
  selectedCandidate: PricesmartLocationCandidate,
  input: ScrapePriceInput
) {
  if (
    !input.unit?.trim() ||
    selectedCandidate.soldByWeight !== true ||
    !selectedCandidate.sourceUnit ||
    !selectedCandidate.parsedSourceUnit
  ) {
    return undefined;
  }

  const parsedProductUnit = parseProductUnit(input);
  if (unitsAreClose(parsedProductUnit, selectedCandidate.parsedSourceUnit)) {
    return undefined;
  }

  const consistentSourceUnit = getConsistentSourceUnit(candidates);
  if (
    !consistentSourceUnit ||
    !unitsAreClose(
      consistentSourceUnit.parsedSourceUnit,
      selectedCandidate.parsedSourceUnit
    )
  ) {
    return undefined;
  }

  return {
    unit: selectedCandidate.sourceUnit,
    baseUnit: selectedCandidate.parsedSourceUnit.normalizedUnit,
    baseUnitAmount: formatAmount(selectedCandidate.parsedSourceUnit.amount),
  };
}

function getPricesmartSkuCandidates(input: ScrapePriceInput) {
  const skuCandidates: string[] = [];

  if (input.api?.trim()) {
    skuCandidates.push(input.api.trim());
  }

  const urlSku = input.url.match(/\/(\d+)\/?$/)?.[1];
  if (urlSku && !skuCandidates.includes(urlSku)) {
    skuCandidates.push(urlSku);
  }

  return skuCandidates;
}

export async function scrapePricesmartPrice(
  input: ScrapePriceInput,
  requestConfig?: FetchWithRetryConfig
): Promise<ScrapePriceResult> {
  const skuCandidates = getPricesmartSkuCandidates(input);
  if (skuCandidates.length === 0) {
    return error(shopId, "missing_api", false, true);
  }

  let result: PricesmartProductResult | null = null;

  for (const sku of skuCandidates) {
    const response = await fetchWithRetry(
      PRICESMART_PRODUCT_API_URL,
      {
        method: "POST",
        body: JSON.stringify([
          { skus: [sku] },
          { products: "getProductBySKU" },
        ]),
        headers: getPricesmartHeaders(),
      },
      requestConfig
    );

    if (!response) {
      return error(shopId, "request_failed", true, true);
    }

    const jsonResponse: unknown = await response.json().catch(() => null);
    if (!jsonResponse) {
      return error(shopId, "invalid_json", true, true);
    }

    const parsed = responseSchema.safeParse(jsonResponse);
    if (!parsed.success) {
      return error(shopId, "invalid_payload", false, true);
    }

    const currentResult = parsed.data.data.products.results[0];
    if (currentResult) {
      result = currentResult;
      break;
    }
  }

  if (!result) {
    return notFound(shopId, "product_not_found", true);
  }

  const attributes = result.masterData.current.allVariants[0]?.attributesRaw ?? [];
  const unitPrice = attributes.find((attr) => attr.name === "unit_price");
  if (!unitPrice) {
    return error(shopId, "unit_price_not_found", false, true);
  }

  const productPrice = parsePriceEntries(unitPrice.value);
  if (!productPrice) {
    return error(shopId, "invalid_unit_price", false, true);
  }

  const originalPriceRaw = attributes.find(
    (attr) => attr.name === "original_price_without_saving"
  );
  const originalPrice = parsePriceEntries(originalPriceRaw?.value) ?? [];
  const weightRaw = attributes.find((attr) => attr.name === "weight");
  const weightUnitRaw = attributes.find((attr) => attr.name === "weight_uom");
  const availabilityRaw = attributes.find(
    (attr) => attr.name === "product_availability"
  );
  const soldByWeightRaw = attributes.find(
    (attr) => attr.name === "sold_by_weight"
  );

  const locationCandidates = buildLocationCandidates({
    productPrice,
    originalPrice,
    weightEntries: parseLocationAttributes(weightRaw?.value),
    weightUnitEntries: parseLocationAttributes(weightUnitRaw?.value),
    availabilityEntries: parseLocationAttributes(availabilityRaw?.value),
    soldByWeightEntries: parseLocationAttributes(soldByWeightRaw?.value),
  });
  const currentPrice = selectLocationCandidate(locationCandidates, input);

  if (!currentPrice) {
    return error(shopId, "do_price_not_found", false, true);
  }

  const unitUpdate = getProductUnitUpdate(
    locationCandidates,
    currentPrice,
    input
  );
  const parsedInputUnit = parseProductUnit(input);
  const unitMismatch =
    currentPrice.soldByWeight === true &&
    !!input.unit?.trim() &&
    !!currentPrice.parsedSourceUnit &&
    !unitsAreClose(parsedInputUnit, currentPrice.parsedSourceUnit) &&
    !unitUpdate;

  if (unitMismatch) {
    return error(shopId, "source_unit_mismatch", false, true);
  }

  return ok(
    shopId,
    currentPrice.currentPrice,
    currentPrice.regularPrice ?? null,
    currentPrice.club ?? null,
    undefined,
    unitUpdate
  );
}
