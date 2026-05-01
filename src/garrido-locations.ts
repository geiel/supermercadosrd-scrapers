export const GARRIDO_DEFAULT_STORE_REFERENCE = "GAD";
export const GARRIDO_FALLBACK_STORE_REFERENCE = "GLA";

export const GARRIDO_STORE_REFERENCES = [
  GARRIDO_DEFAULT_STORE_REFERENCE,
  GARRIDO_FALLBACK_STORE_REFERENCE,
] as const;

const GARRIDO_LOCATION_NAMES: Record<string, string> = {
  GAD: "Autopista Duarte",
  GLA: "Las Americas",
};

export function getGarridoLocationDisplayName(
  locationId: string | null | undefined
) {
  if (!locationId) {
    return null;
  }

  return GARRIDO_LOCATION_NAMES[locationId] ?? null;
}
