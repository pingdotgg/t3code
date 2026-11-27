import { Platform } from "react-native";

export type MobileFontId = "system" | "dm-sans";
export type MobileMonoFontId = "system" | "meslo";

export interface MobileFontFamilies {
  readonly regular: string;
  readonly medium: string;
  readonly bold: string;
}

const SYSTEM_FAMILY = Platform.OS === "ios" ? "System" : "sans-serif";
const SYSTEM_MONO_FAMILY = Platform.OS === "ios" ? "ui-monospace" : "monospace";

// A system family has one name for every weight, so text picks its weight with fontWeight;
// MesloLGS NF does too (app.config.ts maps its weights). Keep bundled names aligned with app.config.ts.
export const MOBILE_FONT_FAMILIES: Readonly<Record<MobileFontId, MobileFontFamilies>> = {
  system: { regular: SYSTEM_FAMILY, medium: SYSTEM_FAMILY, bold: SYSTEM_FAMILY },
  "dm-sans": { regular: "DMSans-Regular", medium: "DMSans-Medium", bold: "DMSans-Bold" },
};

export const MOBILE_MONO_FONT_FAMILIES: Readonly<Record<MobileMonoFontId, string>> = {
  system: SYSTEM_MONO_FAMILY,
  meslo: "MesloLGS-NF-Regular",
};

export const DEFAULT_MOBILE_FONT_ID: MobileFontId = Platform.OS === "ios" ? "system" : "dm-sans";
export const DEFAULT_MOBILE_MONO_FONT_ID: MobileMonoFontId = "system";

export function resolveMobileFontId(value: unknown): MobileFontId {
  return value === "system" || value === "dm-sans" ? value : DEFAULT_MOBILE_FONT_ID;
}

export function resolveMobileMonoFontId(value: unknown): MobileMonoFontId {
  return value === "system" || value === "meslo" ? value : DEFAULT_MOBILE_MONO_FONT_ID;
}

export function resolveFontFamilyVariables(
  fontId: MobileFontId,
  monoFontId: MobileMonoFontId,
): Record<string, string> {
  const families = MOBILE_FONT_FAMILIES[fontId];
  return {
    "--font-sans": families.regular,
    "--font-medium": families.medium,
    "--font-bold": families.bold,
    "--font-mono": MOBILE_MONO_FONT_FAMILIES[monoFontId],
  };
}
