import { CUSTOM_THEME_KEY_PREFIX } from "@t3tools/client-runtime/client-profile/keys";
import type { ClientProfileValueSource } from "@t3tools/client-runtime/client-profile/source";

import {
  readAppearanceModePreference,
  readStoredThemePreference,
  readThemeHalvesRaw,
  setAppearanceMode,
  setTheme,
  setThemeHalf,
  subscribeTheme,
} from "../hooks/useTheme";
import {
  getCustomThemes,
  getThemeColorsForMode,
  getThemeDefinition,
  installCustomTheme,
  isCustomThemeLibraryReady,
  parseStoredTheme,
  refreshCustomThemes,
  removeCustomTheme,
  singleAppearanceOf,
  subscribeToCustomThemes,
  updateCustomTheme,
  type ThemeAppearance,
} from "../themePalette";

const STANDARD_PALETTE = "t3-code";
const APPEARANCES = [
  { appearance: "light", key: "themeLight" },
  { appearance: "dark", key: "themeDark" },
] as const satisfies ReadonlyArray<{ appearance: ThemeAppearance; key: string }>;

function isModeWord(value: unknown): value is "system" | "light" | "dark" {
  return value === "system" || value === "light" || value === "dark";
}

function currentPreference(): string {
  return readStoredThemePreference() ?? "system";
}

function readHalves(): Record<string, string> {
  const preference = currentPreference();
  const stored = readThemeHalvesRaw();
  const definition = getThemeDefinition(preference);
  const single = definition === null ? null : singleAppearanceOf(definition);
  const halves: Record<string, string> = {};
  for (const { appearance, key } of APPEARANCES) {
    const storedHalf = stored[appearance];
    if (storedHalf !== undefined) halves[key] = storedHalf;
    else if (isModeWord(preference)) halves[key] = STANDARD_PALETTE;
    else if (definition !== null && (single === null || single === appearance)) {
      halves[key] = preference;
    }
  }
  return halves;
}

function read() {
  const values: Record<string, unknown> = {
    themeMode: readAppearanceModePreference(currentPreference()),
    ...readHalves(),
  };
  if (!isCustomThemeLibraryReady()) return { values, completePrefixes: [] };
  for (const definition of getCustomThemes()) {
    values[`${CUSTOM_THEME_KEY_PREFIX}${definition.id}`] = definition;
  }
  return { values, completePrefixes: [CUSTOM_THEME_KEY_PREFIX] };
}

function applyCustomThemes(values: Readonly<Record<string, unknown>>): void {
  if (!isCustomThemeLibraryReady()) return;
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(CUSTOM_THEME_KEY_PREFIX)) continue;
    const id = key.slice(CUSTOM_THEME_KEY_PREFIX.length);
    try {
      if (value === null) {
        removeCustomTheme(id);
        continue;
      }
      const theme = parseStoredTheme(value);
      if (theme === null || theme.id !== id) continue;
      if (getCustomThemes().some((existing) => existing.id === id)) updateCustomTheme(theme);
      else installCustomTheme(theme);
    } catch {}
  }
}

function usableHalf(value: unknown, appearance: ThemeAppearance): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === STANDARD_PALETTE) return value;
  const definition = getThemeDefinition(value);
  return definition !== null && getThemeColorsForMode(definition, appearance) !== null
    ? value
    : undefined;
}

function applyHalves(values: Readonly<Record<string, unknown>>): void {
  const current = readHalves();
  const desired = APPEARANCES.map(({ appearance, key }) => usableHalf(values[key], appearance));
  if (desired.every((half) => half === undefined)) return;
  const targets = APPEARANCES.map(({ key }, index) => desired[index] ?? current[key]);
  const [light, dark] = targets;
  if (light !== undefined && dark !== undefined) {
    if (light === dark) {
      setTheme(light === STANDARD_PALETTE ? "system" : light);
      return;
    }
    setTheme("system");
  }
  const written = light !== undefined && dark !== undefined ? targets : desired;
  APPEARANCES.forEach(({ appearance }, index) => {
    const half = written[index];
    if (half !== undefined && half !== STANDARD_PALETTE) setThemeHalf(appearance, half);
  });
}

function applyThemeMode(value: unknown): void {
  if (!isModeWord(value)) return;
  if (value !== readAppearanceModePreference(currentPreference())) setAppearanceMode(value);
}

export function createWebThemeSource(): ClientProfileValueSource {
  return {
    owns: (base) =>
      base === "themeMode" ||
      base === "themeLight" ||
      base === "themeDark" ||
      base.startsWith(CUSTOM_THEME_KEY_PREFIX),
    ready: () => {
      refreshCustomThemes();
      return Promise.resolve();
    },
    read,
    defaults: () => ({
      themeMode: "system",
      themeLight: STANDARD_PALETTE,
      themeDark: STANDARD_PALETTE,
    }),
    apply: (values) => {
      applyCustomThemes(values);
      applyHalves(values);
      applyThemeMode(values.themeMode);
      const stored = read().values;
      return Promise.resolve(
        Object.fromEntries(Object.entries(stored).filter(([key]) => key in values)),
      );
    },
    subscribe: (onChange) => {
      const unsubscribers = [subscribeTheme(onChange), subscribeToCustomThemes(onChange)];
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
  };
}

export function themeProfileValuesForDefault(
  themeId: string,
  setsOwnMode = true,
): Record<string, unknown> | null {
  const definition = getThemeDefinition(themeId);
  if (definition === null) return null;
  const single = singleAppearanceOf(definition);
  if (single === null) return { themeLight: themeId, themeDark: themeId };
  const half = { [single === "light" ? "themeLight" : "themeDark"]: themeId };
  return setsOwnMode ? { ...half, themeMode: single } : half;
}
