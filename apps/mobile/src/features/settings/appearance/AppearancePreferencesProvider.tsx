import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform, useColorScheme } from "react-native";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { Uniwind } from "uniwind";

import {
  resolveAppearance,
  resolveAppearancePreferences,
  resolveTextScaleVariables,
  type ResolvedAppearance,
} from "../../../lib/appearancePreferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import type { Preferences } from "../../../persistence/mobile-preferences";
import {
  isSystemColorsAvailable,
  readSystemColorPalettes,
  type MaterialYouPalettes,
} from "../../../lib/materialYouPalette";
import { materialYouPaletteToMobileThemeVariables } from "../../../lib/materialYouTheme";
import {
  createMobileThemePairPatch,
  createMobileThemeSelectionPatch,
  getMobileThemeVariables,
  normalizeMobileThemeMode,
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeIds,
  type MobileThemeMode,
} from "../../../lib/mobileTheme";
import { cacheTerminalFontSize } from "../../terminal/terminalUiState";

interface AppearancePreferencesContextValue {
  /** Effective values with base-size derivation applied. Use this for rendering. */
  readonly appearance: ResolvedAppearance;
  readonly themeId: MobileThemeId;
  readonly themeIds: MobileThemeIds;
  readonly themeMode: MobileThemeMode;
  readonly themeAppearance: MobileThemeAppearance;
  readonly systemColorsAvailable: boolean;
  readonly systemColorsEnabled: boolean;
  readonly systemColorsActive: boolean;
  readonly materialYouStyleLayoutEnabled: boolean;
  readonly materialYouStyleLayoutActive: boolean;
  readonly isReady: boolean;
  readonly setThemeIdForAppearance: (
    appearance: MobileThemeAppearance,
    value: MobileThemeId,
  ) => void;
  readonly setThemeIdForBothAppearances: (value: MobileThemeId) => void;
  readonly setThemeMode: (value: MobileThemeMode) => void;
  readonly setSystemColorsEnabled: (value: boolean) => void;
  readonly setMaterialYouStyleLayoutEnabled: (value: boolean) => void;
  readonly setBaseFontSize: (value: number) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setTerminalFontSize: (value: number | null) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setCodeFontSize: (value: number | null) => void;
  readonly setCodeWordBreak: (value: boolean) => void;
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null);

/**
 * Injects palette and text-scale variables into both adaptive stylesheets.
 * Updating the active sheet last lets the visible app settle in one pass.
 */
function applyAppearanceVariables(
  baseFontSize: number,
  themeIds: MobileThemeIds,
  systemColorPalettes: MaterialYouPalettes | null,
) {
  const textVariables = resolveTextScaleVariables(baseFontSize);
  const currentTheme = Uniwind.currentTheme;
  const activeAppearance =
    currentTheme === "light" || currentTheme === "dark" ? currentTheme : null;

  for (const theme of ["light", "dark"] as const) {
    const authoredVariables = getMobileThemeVariables(themeIds[theme], theme);
    const colorVariables = systemColorPalettes
      ? materialYouPaletteToMobileThemeVariables(
          systemColorPalettes[theme],
          theme,
          authoredVariables,
        )
      : authoredVariables;
    const variables = { ...colorVariables, ...textVariables };
    if (theme !== activeAppearance) {
      Uniwind.updateCSSVariables(theme, variables);
    }
  }
  if (activeAppearance !== null) {
    const authoredVariables = getMobileThemeVariables(themeIds[activeAppearance], activeAppearance);
    Uniwind.updateCSSVariables(activeAppearance, {
      ...(systemColorPalettes
        ? materialYouPaletteToMobileThemeVariables(
            systemColorPalettes[activeAppearance],
            activeAppearance,
            authoredVariables,
          )
        : authoredVariables),
      ...textVariables,
    });
  }
}

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [systemColorsRefreshKey, setSystemColorsRefreshKey] = useState(0);
  const systemColorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const storedPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : null;
  const preferences = useMemo(
    () => resolveAppearancePreferences(storedPreferences),
    [storedPreferences],
  );
  const themeMode = normalizeMobileThemeMode(storedPreferences?.themeMode);
  const themeAppearance = themeMode === "system" ? systemColorScheme : themeMode;
  const themeIds = useMemo(
    () => resolveMobileThemeIds(storedPreferences ?? {}),
    [storedPreferences],
  );
  const themeId = themeIds[themeAppearance];
  const isReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const systemColorsEnabled = storedPreferences?.systemColorsEnabled ?? false;
  const systemColorsActive = systemColorsEnabled && isSystemColorsAvailable;
  const materialYouStyleLayoutEnabled = storedPreferences?.materialYouStyleLayoutEnabled ?? false;
  const materialYouStyleLayoutActive = Platform.OS === "android" && materialYouStyleLayoutEnabled;
  const systemColorPalettes = useMemo(
    () => (systemColorsActive ? readSystemColorPalettes() : null),
    [systemColorsActive, systemColorsRefreshKey],
  );

  useEffect(() => {
    if (!systemColorsActive) return;
    const refreshPalette = () => setSystemColorsRefreshKey((key) => key + 1);
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshPalette();
    });
    const focusSubscription =
      Platform.OS === "android" ? AppState.addEventListener("focus", refreshPalette) : null;
    return () => {
      appStateSubscription.remove();
      focusSubscription?.remove();
    };
  }, [systemColorsActive]);

  useLayoutEffect(() => {
    applyAppearanceVariables(preferences.baseFontSize, themeIds, systemColorPalettes);
    Uniwind.setTheme(themeMode);
    cacheTerminalFontSize(resolveAppearance(preferences).terminalFontSize);
  }, [preferences, systemColorPalettes, themeIds, themeMode]);

  const updatePreferences = useCallback(
    (patch: Partial<Preferences>) => {
      savePreferences(patch);
    },
    [savePreferences],
  );

  const setThemeIdForAppearance = useCallback(
    (appearance: MobileThemeAppearance, value: MobileThemeId) => {
      updatePreferences(
        createMobileThemeSelectionPatch(themeIds, themeAppearance, appearance, value),
      );
    },
    [themeAppearance, themeIds, updatePreferences],
  );

  const setThemeIdForBothAppearances = useCallback(
    (value: MobileThemeId) => {
      updatePreferences(createMobileThemePairPatch(value));
    },
    [updatePreferences],
  );

  const setThemeMode = useCallback(
    (value: MobileThemeMode) => {
      updatePreferences({ themeMode: value });
    },
    [updatePreferences],
  );

  const setSystemColorsEnabled = useCallback(
    (value: boolean) => {
      updatePreferences({ systemColorsEnabled: value });
    },
    [updatePreferences],
  );

  const setMaterialYouStyleLayoutEnabled = useCallback(
    (value: boolean) => {
      updatePreferences({ materialYouStyleLayoutEnabled: value });
    },
    [updatePreferences],
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

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance: resolveAppearance(preferences),
      themeId,
      themeIds,
      themeMode,
      themeAppearance,
      systemColorsAvailable: isSystemColorsAvailable,
      systemColorsEnabled,
      systemColorsActive,
      materialYouStyleLayoutEnabled,
      materialYouStyleLayoutActive,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      setThemeMode,
      setSystemColorsEnabled,
      setMaterialYouStyleLayoutEnabled,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
    }),
    [
      preferences,
      themeId,
      themeIds,
      themeMode,
      themeAppearance,
      systemColorsEnabled,
      systemColorsActive,
      materialYouStyleLayoutEnabled,
      materialYouStyleLayoutActive,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      setThemeMode,
      setSystemColorsEnabled,
      setMaterialYouStyleLayoutEnabled,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
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
