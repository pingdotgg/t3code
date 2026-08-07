import { createContext, use, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  getDefaultThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from "@t3tools/themes";

import { Uniwind } from "uniwind";

import {
  resolveAppearance,
  resolveAppearancePreferences,
  resolveTextScaleVariables,
  type ResolvedAppearance,
} from "../../../lib/appearancePreferences";
import { themeColorsToMobileCSSVariables } from "../../../lib/mobileTheme";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import type { Preferences } from "../../../persistence/mobile-preferences";
import { cacheTerminalFontSize } from "../../terminal/terminalUiState";

export type MobileAppearanceMode = "system" | ThemeAppearance;

interface AppearancePreferencesContextValue {
  /** Effective values with base-size derivation applied. Use this for rendering. */
  readonly appearance: ResolvedAppearance;
  /** Effective light/dark mode after applying the device-local override. */
  readonly colorScheme: ThemeAppearance;
  readonly appearanceMode: MobileAppearanceMode;
  /** Null means the stock global.css palette is still active. */
  readonly themeId: string | null;
  readonly themeDefinition: ThemeDefinition | null;
  /** Null for the stock palette; unknown ids use the canonical fallback. */
  readonly themeColors: ThemeColors | null;
  readonly isReady: boolean;
  readonly setBaseFontSize: (value: number) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setTerminalFontSize: (value: number | null) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setCodeFontSize: (value: number | null) => void;
  readonly setCodeWordBreak: (value: boolean) => void;
  readonly setThemeId: (value: string) => void;
  readonly setAppearanceMode: (value: MobileAppearanceMode) => void;
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null);

/**
 * Injects the scaled `--text-*` variables into Uniwind so every
 * className-based text size (`text-sm`, `text-base`, ...) re-resolves live.
 * Updates the current theme last so the active stylesheet settles correctly.
 */
function applyTextScaleVariables(baseFontSize: number) {
  const variables = resolveTextScaleVariables(baseFontSize);
  const currentTheme = Uniwind.currentTheme;

  for (const theme of ["light", "dark"] as const) {
    if (theme !== currentTheme) {
      Uniwind.updateCSSVariables(theme, variables);
    }
  }
  Uniwind.updateCSSVariables(currentTheme, variables);
}

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const nativeColorScheme = useColorScheme();
  const storedPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : null;
  const preferences = useMemo(
    () => resolveAppearancePreferences(storedPreferences),
    [storedPreferences],
  );
  const isReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const appearanceMode: MobileAppearanceMode = storedPreferences?.appearanceMode ?? "system";
  const themeId = storedPreferences?.themeId ?? null;
  const colorScheme: ThemeAppearance =
    appearanceMode === "system"
      ? nativeColorScheme === "dark"
        ? "dark"
        : "light"
      : appearanceMode;
  const themeDefinition = useMemo(
    () => (themeId === null ? null : getThemeDefinition(themeId)),
    [themeId],
  );
  const themeColors = useMemo(() => {
    if (themeId === null) return null;
    if (themeDefinition === null) return getDefaultThemeColors(colorScheme);
    return (
      getThemeColorsForMode(themeDefinition, colorScheme) ?? getDefaultThemeColors(colorScheme)
    );
  }, [colorScheme, themeDefinition, themeId]);

  useEffect(() => {
    // Uniwind owns the native Appearance override. Keeping this in the same
    // provider as useColorScheme gives every screen the same effective mode.
    Uniwind.setTheme(isReady ? appearanceMode : "system");
  }, [appearanceMode, isReady]);

  useEffect(() => {
    if (themeId === null) {
      // No injection is intentional: global.css remains the fresh-install
      // fallback until the user picks a built-in theme.
      return;
    }

    for (const mode of ["light", "dark"] as const) {
      const colors =
        (themeDefinition && getThemeColorsForMode(themeDefinition, mode)) ??
        getDefaultThemeColors(mode);
      Uniwind.updateCSSVariables(mode, themeColorsToMobileCSSVariables(colors));
    }
  }, [themeDefinition, themeId]);

  useEffect(() => {
    applyTextScaleVariables(preferences.baseFontSize);
    cacheTerminalFontSize(resolveAppearance(preferences).terminalFontSize);
  }, [preferences]);

  const updatePreferences = useCallback(
    (patch: Partial<Preferences>) => {
      savePreferences(patch);
    },
    [savePreferences],
  );

  const setBaseFontSize = useCallback(
    (value: number) => {
      updatePreferences({ baseFontSize: value });
    },
    [updatePreferences],
  );

  const setTerminalFontSize = useCallback(
    (value: number | null) => {
      updatePreferences({ terminalFontSize: value });
    },
    [updatePreferences],
  );

  const setCodeFontSize = useCallback(
    (value: number | null) => {
      updatePreferences({ codeFontSize: value });
    },
    [updatePreferences],
  );

  const setCodeWordBreak = useCallback(
    (value: boolean) => {
      updatePreferences({ codeWordBreak: value });
    },
    [updatePreferences],
  );

  const setThemeId = useCallback(
    (value: string) => {
      updatePreferences({ themeId: value });
    },
    [updatePreferences],
  );

  const setAppearanceMode = useCallback(
    (value: MobileAppearanceMode) => {
      updatePreferences({ appearanceMode: value });
    },
    [updatePreferences],
  );

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance: resolveAppearance(preferences),
      appearanceMode,
      colorScheme,
      isReady,
      setAppearanceMode,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
      setThemeId,
      themeColors,
      themeDefinition,
      themeId,
    }),
    [
      appearanceMode,
      colorScheme,
      isReady,
      preferences,
      setAppearanceMode,
      setBaseFontSize,
      setCodeFontSize,
      setCodeWordBreak,
      setTerminalFontSize,
      setThemeId,
      themeColors,
      themeDefinition,
      themeId,
    ],
  );

  return (
    <AppearancePreferencesContext.Provider value={value}>
      {props.children}
    </AppearancePreferencesContext.Provider>
  );
}

export function useAppearancePreferences(): AppearancePreferencesContextValue {
  const context = use(AppearancePreferencesContext);
  if (!context) {
    throw new Error("useAppearancePreferences must be used within AppearancePreferencesProvider");
  }
  return context;
}

/** Centralized replacement for React Native's OS-only useColorScheme hook. */
export function useAppearanceColorScheme(): ThemeAppearance {
  return useAppearancePreferences().colorScheme;
}
