import * as Schema from "effect/Schema";
import type { ThemeAppearance } from "@t3tools/shared/themePalettes";

export const T3_CHAT_THEME_ID = "t3-chat" as const;
export const GROVE_THEME_ID = "grove" as const;
export const OCEAN_THEME_ID = "ocean" as const;
export const EMBER_THEME_ID = "ember" as const;
export const IRIS_THEME_ID = "iris" as const;
export const LEGACY_T3_CHAT_DARK_THEME_ID = "t3-chat-dark";

export const ThemePreference = Schema.String;
export type ThemePreference = typeof ThemePreference.Type;

export const LEGACY_THEME_ID_ALIASES: Readonly<Record<string, string>> = {
  [LEGACY_T3_CHAT_DARK_THEME_ID]: T3_CHAT_THEME_ID,
  "t3-grove": GROVE_THEME_ID,
  "t3-ocean": OCEAN_THEME_ID,
  "t3-ember": EMBER_THEME_ID,
  "t3-iris": IRIS_THEME_ID,
};

export function normalizeThemeId(themeId: string): string {
  return LEGACY_THEME_ID_ALIASES[themeId] ?? themeId;
}

/** Old dark-only ids stay as written so a user's stored preference keeps working. */
export function canonicalThemePreference(theme: string): string {
  return theme === LEGACY_T3_CHAT_DARK_THEME_ID ? theme : normalizeThemeId(theme);
}

export function themeIdFromPreference(theme: ThemePreference): string {
  return normalizeThemeId(theme);
}

export function legacyThemeMode(theme: ThemePreference): ThemeAppearance | null {
  return theme === LEGACY_T3_CHAT_DARK_THEME_ID ? "dark" : null;
}
