import {
  MAX_IMPORTED_THEMES,
  MAX_IMPORTED_THEMES_BYTES,
  MAX_THEME_FILE_BYTES,
  THEME_FILE_VERSION,
  addPortableTheme,
  parsePortableThemeFile,
  parsePortableThemeFileJson,
  sanitizePortableThemes,
  themeColorToHex,
  type PortableThemeFile,
  type ThemeColorOverrides,
} from "@t3tools/shared/themeFile";

export const MOBILE_THEME_FILE_VERSION = THEME_FILE_VERSION;
export const MAX_MOBILE_THEME_FILE_BYTES = MAX_THEME_FILE_BYTES;
export const MAX_IMPORTED_MOBILE_THEMES = MAX_IMPORTED_THEMES;
export const MAX_IMPORTED_MOBILE_THEMES_BYTES = MAX_IMPORTED_THEMES_BYTES;

export type ImportedMobileTheme = PortableThemeFile;
export type PortableThemeColorOverrides = ThemeColorOverrides;

export const parseMobileThemeFile = parsePortableThemeFile;
export const parseMobileThemeFileJson = parsePortableThemeFileJson;
export const addImportedMobileTheme = addPortableTheme;
export const sanitizeImportedMobileThemes = sanitizePortableThemes;

export function normalizeMobileThemeColorLiteral(value: string): string | null {
  return themeColorToHex(value);
}
