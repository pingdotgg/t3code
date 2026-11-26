import type { ClientActivityReportInput } from "@t3tools/contracts";

/** Omitted unless Battery Saver is on in Labs, so hosts keep treating the phone as unknown. */
export function reportedLowPowerMode(
  batterySaverEnabled: boolean,
  powerSaveMode: boolean | null,
): Pick<ClientActivityReportInput, "lowPowerMode"> {
  if (!batterySaverEnabled) return {};
  return { lowPowerMode: powerSaveMode === null ? "unknown" : powerSaveMode ? "true" : "false" };
}
