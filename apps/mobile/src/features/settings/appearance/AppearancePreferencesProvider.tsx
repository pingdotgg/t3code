import {
  createContext,
  startTransition,
  use,
  useCallback,
  useEffect,
  useState,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { AppState, Appearance, Platform, useColorScheme } from "react-native";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { ScopedTheme, ScopedVariables, Uniwind } from "uniwind";

import {
  resolveAppearance,
  resolveAppearancePreferences,
  type ResolvedAppearance,
} from "../../../lib/appearancePreferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import type { Preferences } from "../../../persistence/mobile-preferences";
import { isSystemColorsAvailable, readSystemColorPalettes } from "../../../lib/materialYouPalette";
import { materialYouPaletteToMobileThemeVariables } from "../../../lib/materialYouTheme";
import { getMobileThemeRuntimeVariables } from "../../../lib/mobileThemeVariables";
import type { MobileThemeVariables } from "../../../lib/mobileTheme";
import {
  createMobileThemePairPatch,
  createMobileThemeSelectionPatch,
  normalizeMobileThemeMode,
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeIds,
  type MobileThemeMode,
} from "../../../lib/mobileTheme";
import {
  createMobileThemeRuntimeOperations,
  getMobileUniwindThemeName,
  type MobileThemeRuntimeState,
} from "../../../lib/mobileThemeRuntime";

interface AppearancePreferencesContextValue {
  readonly appearance: ResolvedAppearance;
  readonly themeId: MobileThemeId;
  readonly themeIds: MobileThemeIds;
  readonly themeMode: MobileThemeMode;
  readonly themeAppearance: MobileThemeAppearance;
  readonly systemColorsAvailable: boolean;
  readonly systemColorsActive: boolean;
  readonly themeVariables: MobileThemeVariables;
  readonly themeVariablesByAppearance: Readonly<
    Record<MobileThemeAppearance, MobileThemeVariables>
  >;
  readonly systemColorPalettes: ReturnType<typeof readSystemColorPalettes>;
  readonly isReady: boolean;
  readonly setThemeIdForAppearance: (
    appearance: MobileThemeAppearance,
    value: MobileThemeId,
  ) => void;
  readonly setThemeIdForBothAppearances: (value: MobileThemeId) => void;
  readonly setThemeMode: (value: MobileThemeMode) => void;
  readonly setBaseFontSize: (value: number) => void;
  readonly setTerminalFontSize: (value: number | null) => void;
  readonly setCodeFontSize: (value: number | null) => void;
  readonly setCodeWordBreak: (value: boolean) => void;
  readonly mathRenderingEnabled: boolean;
  readonly setMathRenderingEnabled: (value: boolean) => void;
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null);

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
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
  const resolvedThemeIds = resolveMobileThemeIds(storedPreferences ?? {});
  const themeIds = useMemo<MobileThemeIds>(
    () => ({ light: resolvedThemeIds.light, dark: resolvedThemeIds.dark }),
    [resolvedThemeIds.dark, resolvedThemeIds.light],
  );
  const themeId = themeIds[themeAppearance];
  const systemColorsActive = themeId === "material-you" && isSystemColorsAvailable;
  const [systemColorPalettes, setSystemColorPalettes] = useState(readSystemColorPalettes);
  useEffect(() => {
    if (!isSystemColorsAvailable) return;
    const refresh = () => {
      const next = readSystemColorPalettes();
      setSystemColorPalettes((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    const focusSubscription = AppState.addEventListener("focus", refresh);
    return () => {
      subscription.remove();
      focusSubscription.remove();
    };
  }, []);
  const themeVariablesByAppearance = useMemo(() => {
    const resolve = (appearance: MobileThemeAppearance) => {
      const base = getMobileThemeRuntimeVariables(themeIds[appearance], appearance, Platform.OS);
      return themeIds[appearance] === "material-you" && systemColorPalettes
        ? materialYouPaletteToMobileThemeVariables(
            systemColorPalettes[appearance],
            appearance,
            base,
          )
        : base;
    };
    return { light: resolve("light"), dark: resolve("dark") };
  }, [themeIds, systemColorPalettes]);
  const themeVariables = themeVariablesByAppearance[themeAppearance];
  const activeThemeName = getMobileUniwindThemeName(themeId, themeAppearance);
  const { baseFontSize, codeFontSize, codeWordBreak, terminalFontSize } = preferences;
  const appearance = useMemo(
    () => resolveAppearance({ baseFontSize, codeFontSize, codeWordBreak, terminalFontSize }),
    [baseFontSize, codeFontSize, codeWordBreak, terminalFontSize],
  );
  const isReady = AsyncResult.isSuccess(preferencesResult);
  const runtimeState = useMemo<MobileThemeRuntimeState>(
    () => ({
      baseFontSize,
      themeAppearance,
      themeMode,
    }),
    [baseFontSize, themeAppearance, themeMode],
  );
  const appliedRuntimeStateRef = useRef<MobileThemeRuntimeState | null>(null);
  const selectedThemeIdsRef = useRef(themeIds);

  const applyThemeRuntime = useCallback((next: MobileThemeRuntimeState) => {
    const operations = createMobileThemeRuntimeOperations(appliedRuntimeStateRef.current, next);
    for (const operation of operations) {
      if (operation.kind === "update-text-variables") {
        Uniwind.updateCSSVariables(operation.themeName, operation.variables);
        continue;
      }
      if (operation.kind === "set-appearance-mode") {
        Appearance.setColorScheme(
          operation.themeMode === "system" ? "unspecified" : operation.appearance,
        );
      }
    }
    appliedRuntimeStateRef.current = next;
  }, []);

  const syncThemeRuntime = useCallback(
    (next: MobileThemeRuntimeState) => applyThemeRuntime(next),
    [applyThemeRuntime],
  );

  const updatePreferences = useCallback(
    (patch: Partial<Preferences>) => {
      startTransition(() => savePreferences(patch));
    },
    [savePreferences],
  );

  const updateThemePreferences = useCallback(
    (patch: Partial<Preferences>) => {
      savePreferences(patch);
    },
    [savePreferences],
  );

  useLayoutEffect(() => {
    selectedThemeIdsRef.current = themeIds;
    syncThemeRuntime(runtimeState);
  }, [runtimeState, syncThemeRuntime, themeIds]);

  const setThemeIdForAppearance = useCallback(
    (appearance: MobileThemeAppearance, value: MobileThemeId) => {
      const patch = createMobileThemeSelectionPatch(
        selectedThemeIdsRef.current,
        themeAppearance,
        appearance,
        value,
      );
      selectedThemeIdsRef.current = resolveMobileThemeIds(patch);
      updateThemePreferences(patch);
    },
    [themeAppearance, updateThemePreferences],
  );

  const setThemeIdForBothAppearances = useCallback(
    (value: MobileThemeId) => {
      const patch = createMobileThemePairPatch(value);
      selectedThemeIdsRef.current = resolveMobileThemeIds(patch);
      updateThemePreferences(patch);
    },
    [updateThemePreferences],
  );

  const setThemeMode = useCallback(
    (value: MobileThemeMode) => {
      const current = appliedRuntimeStateRef.current ?? runtimeState;

      // Clear forced appearance before publishing System so useColorScheme batches the system palette into the preference commit.
      if (value === "system") {
        Appearance.setColorScheme("unspecified");
      }
      const nextAppearance =
        value === "system" ? (Appearance.getColorScheme() === "dark" ? "dark" : "light") : value;
      const next = {
        ...current,
        themeAppearance: nextAppearance,
        themeMode: value,
      };

      updateThemePreferences({ themeMode: value });
      if (value === "system") {
        appliedRuntimeStateRef.current = next;
      } else {
        syncThemeRuntime(next);
      }
    },
    [runtimeState, syncThemeRuntime, updateThemePreferences],
  );

  const setBaseFontSize = useCallback(
    (value: number) => {
      const current = appliedRuntimeStateRef.current ?? runtimeState;
      syncThemeRuntime({ ...current, baseFontSize: value });
      updatePreferences({ baseFontSize: value });
    },
    [runtimeState, syncThemeRuntime, updatePreferences],
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

  const mathRenderingEnabled = storedPreferences?.mathRenderingEnabled === true;
  const setMathRenderingEnabled = useCallback(
    (value: boolean) => updatePreferences({ mathRenderingEnabled: value }),
    [updatePreferences],
  );

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance,
      themeId,
      themeIds,
      themeMode,
      themeAppearance,
      systemColorsAvailable: isSystemColorsAvailable,
      systemColorsActive,
      themeVariables,
      themeVariablesByAppearance,
      systemColorPalettes,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      setThemeMode,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
      mathRenderingEnabled,
      setMathRenderingEnabled,
    }),
    [
      appearance,
      themeId,
      themeIds,
      themeMode,
      themeAppearance,
      systemColorsActive,
      themeVariables,
      themeVariablesByAppearance,
      systemColorPalettes,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      setThemeMode,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
      mathRenderingEnabled,
      setMathRenderingEnabled,
    ],
  );

  return (
    <AppearancePreferencesContext.Provider value={value}>
      <ScopedTheme theme={activeThemeName}>
        <ScopedVariables variables={themeVariables}>{props.children}</ScopedVariables>
      </ScopedTheme>
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
