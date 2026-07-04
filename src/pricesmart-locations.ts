export const PREFERRED_DO_PRICESMART_LOCATION_IDS = [
  "6801",
  "6804",
  "6805",
  "6806",
  "6802",
] as const;
export const PRICESMART_DO_DEFAULT_LOCATION_ID = "68";

const PRICESMART_DO_LOCATION_NAMES: Record<string, string> = {
  [PRICESMART_DO_DEFAULT_LOCATION_ID]: "Republica Dominicana",
  "6801": "Los Prados",
  "6802": "Santiago",
  "6804": "Arroyo Hondo",
  "6805": "San Isidro",
  "6806": "Bolivar",
};

type PricesmartLocationPriceEntry = {
  country: string;
  club?: string;
  value: string | null | undefined;
};

export function getPreferredDoPricesmartLocationPrice<
  T extends PricesmartLocationPriceEntry,
>(entries: T[]): T | undefined {
  const dominicanRepublicEntries = entries.filter((entry) => entry.country === "DO");

  for (const locationId of PREFERRED_DO_PRICESMART_LOCATION_IDS) {
    const preferredEntry = dominicanRepublicEntries.find(
      (entry) => entry.club === locationId && Number(entry.value) > 0
    );

    if (preferredEntry) {
      return preferredEntry;
    }
  }

  return dominicanRepublicEntries.find(
    (entry) =>
      entry.club === PRICESMART_DO_DEFAULT_LOCATION_ID && Number(entry.value) > 0
  );
}

export function getPricesmartLocationDisplayName(
  locationId: string | null | undefined
) {
  if (!locationId) {
    return null;
  }

  return PRICESMART_DO_LOCATION_NAMES[locationId] ?? null;
}
