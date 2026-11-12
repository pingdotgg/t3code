/**
 * The fork ships the mobile app as T3 Agents (see app.config.ts). Every header and label reads
 * the name from here, so an upstream sync that edits a header cannot quietly bring back
 * "T3 Code": it has to change this file, which mobileBranding.test.ts pins.
 */
export const MOBILE_APP_NAME = "T3 Agents";
/** The words after the "T3" wordmark in the compact brand title. */
export const MOBILE_APP_NAME_SUFFIX = MOBILE_APP_NAME.replace(/^T3\s+/, "");

export type MobileStageLabel = "Dev" | "Nightly";

/** Release builds carry no stage badge; dev and preview builds keep one to tell them apart. */
export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel | null {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return null;
}
