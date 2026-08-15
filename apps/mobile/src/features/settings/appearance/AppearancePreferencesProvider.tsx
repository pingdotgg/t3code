import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { Appearance, useColorScheme } from "react-native";

import { Uniwind } from "uniwind";

import {
  resolveAppearance,
  resolveAppearancePreferences,
  resolveTextScaleVariables,
  type ResolvedAppearance,
} from "../../../lib/appearancePreferences";
import {
  resolveColorSchemeOverride,
  removeImportedMobileTheme,
  resolveMobileNativeSurfaceColors,
  resolveMobileThemePreferences,
  resolveMobileThemeVariables,
  isMobileThemeId,
  type MobileAppearanceMode,
  type MobileNativeSurfaceColors,
  type MobileThemeAppearance,
  type MobileThemeId,
} from "../../../lib/mobileTheme";
import {
  addImportedMobileTheme,
  parseMobileThemeFileJson,
  type ImportedMobileTheme,
} from "../../../lib/mobileThemeFile";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import {
  useUpdateAppearanceModePreference,
  useUpdateThemePreference,
} from "../../../state/synced-client-preferences";
import { cacheTerminalFontSize } from "../../terminal/terminalUiState";

interface AppearancePreferencesContextValue {
  /** Effective values with base-size derivation applied. Use this for rendering. */
  readonly appearance: ResolvedAppearance;
  readonly appearanceMode: MobileAppearanceMode;
  readonly effectiveColorScheme: MobileThemeAppearance;
  readonly themeId: MobileThemeId;
  readonly importedThemes: ReadonlyArray<ImportedMobileTheme>;
  readonly nativeSurfaceColors: MobileNativeSurfaceColors | null;
  readonly isReady: boolean;
  readonly setAppearanceMode: (value: MobileAppearanceMode) => void;
  readonly setThemeId: (value: MobileThemeId) => void;
  readonly importThemeJson: (value: string) => void;
  readonly removeImportedTheme: (themeId: string) => void;
  readonly setBaseFontSize: (value: number) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setTerminalFontSize: (value: number | null) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setCodeFontSize: (value: number | null) => void;
  readonly setCodeWordBreak: (value: boolean) => void;
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null);

interface ImportedThemeRemovalConfirmationState {
  readonly importedThemes: ReadonlyArray<ImportedMobileTheme>;
  readonly selectedThemeId: MobileThemeId;
  readonly saveImportedThemes: (themes: ReadonlyArray<ImportedMobileTheme>) => void;
  readonly publishThemeId: (themeId: MobileThemeId) => void;
}

export function applyImportedThemeRemovalAtConfirmation(
  removedThemeId: string,
  current: ImportedThemeRemovalConfirmationState,
) {
  const patch = removeImportedMobileTheme(
    current.importedThemes,
    removedThemeId,
    current.selectedThemeId,
  );
  if (!patch) return;
  current.saveImportedThemes(patch.importedThemes);
  if (patch.themeId !== undefined) current.publishThemeId(patch.themeId);
}

/** Updates the active stylesheet last so it settles correctly. */
function updateCSSVariables(
  resolveVariables: (theme: MobileThemeAppearance) => Readonly<Record<string, string | number>>,
) {
  const currentTheme = Uniwind.currentTheme;
  const inactiveTheme = currentTheme === "light" ? "dark" : "light";
  Uniwind.updateCSSVariables(inactiveTheme, resolveVariables(inactiveTheme));
  Uniwind.updateCSSVariables(currentTheme, resolveVariables(currentTheme));
}

function applyThemeVariables(
  themeId: MobileThemeId,
  importedThemes: ReadonlyArray<ImportedMobileTheme>,
) {
  updateCSSVariables((theme) => resolveMobileThemeVariables(themeId, theme, importedThemes));
}

export function applyAppearanceModeToRuntimes(appearanceMode: MobileAppearanceMode) {
  const colorSchemeOverride = resolveColorSchemeOverride(appearanceMode);
  Uniwind.setTheme(colorSchemeOverride ?? "system");
  Appearance.setColorScheme(colorSchemeOverride ?? "unspecified");
}

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const setAppearanceMode = useUpdateAppearanceModePreference();
  const updateThemePreference = useUpdateThemePreference();
  const systemColorScheme = useColorScheme();
  const [hasAppliedInitialPreferences, setHasAppliedInitialPreferences] = useState(false);
  const preferences = useMemo(
    () =>
      resolveAppearancePreferences(
        AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null,
      ),
    [preferencesResult],
  );
  const importedThemesJson = JSON.stringify(
    AsyncResult.isSuccess(preferencesResult) ? (preferencesResult.value.importedThemes ?? []) : [],
  );
  const importedThemes = useMemo(
    () => JSON.parse(importedThemesJson) as ReadonlyArray<ImportedMobileTheme>,
    [importedThemesJson],
  );
  const themePreferences = useMemo(
    () =>
      resolveMobileThemePreferences(
        AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null,
        importedThemes,
      ),
    [importedThemes, preferencesResult],
  );
  const preferencesLoaded = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const effectiveColorScheme =
    resolveColorSchemeOverride(themePreferences.appearanceMode) ??
    (systemColorScheme === "dark" ? "dark" : "light");
  const nativeSurfaceColors = useMemo(
    () =>
      resolveMobileNativeSurfaceColors(
        themePreferences.themeId,
        effectiveColorScheme,
        importedThemes,
      ),
    [effectiveColorScheme, importedThemes, themePreferences.themeId],
  );
  const importedThemeRemovalState = useRef<ImportedThemeRemovalConfirmationState>({
    importedThemes,
    selectedThemeId: themePreferences.themeId,
    saveImportedThemes: (themes) => savePreferences({ importedThemes: themes }),
    publishThemeId: updateThemePreference,
  });
  importedThemeRemovalState.current = {
    importedThemes,
    selectedThemeId: themePreferences.themeId,
    saveImportedThemes: (themes) => savePreferences({ importedThemes: themes }),
    publishThemeId: updateThemePreference,
  };

  useEffect(() => {
    applyThemeVariables(themePreferences.themeId, importedThemes);
  }, [importedThemes, themePreferences.themeId]);

  useEffect(() => {
    applyAppearanceModeToRuntimes(themePreferences.appearanceMode);
  }, [themePreferences.appearanceMode]);

  useEffect(() => {
    const variables = resolveTextScaleVariables(preferences.baseFontSize);
    updateCSSVariables(() => variables);
  }, [preferences.baseFontSize]);

  useEffect(() => {
    cacheTerminalFontSize(resolveAppearance(preferences).terminalFontSize);
  }, [preferences.baseFontSize, preferences.terminalFontSize]);

  useEffect(() => {
    if (preferencesLoaded) setHasAppliedInitialPreferences(true);
  }, [preferencesLoaded]);

  const isReady = preferencesLoaded && hasAppliedInitialPreferences;

  const setBaseFontSize = useCallback(
    (value: number) => {
      savePreferences({ baseFontSize: value });
    },
    [savePreferences],
  );

  const setTerminalFontSize = useCallback(
    (value: number | null) => {
      savePreferences({ terminalFontSize: value });
    },
    [savePreferences],
  );

  const setCodeFontSize = useCallback(
    (value: number | null) => {
      savePreferences({ codeFontSize: value });
    },
    [savePreferences],
  );

  const setCodeWordBreak = useCallback(
    (value: boolean) => {
      savePreferences({ codeWordBreak: value });
    },
    [savePreferences],
  );

  const setThemeId = useCallback(
    (value: MobileThemeId) => {
      if (!isMobileThemeId(value, importedThemes)) return;
      updateThemePreference(value);
    },
    [importedThemes, updateThemePreference],
  );

  const importThemeJson = useCallback(
    (source: string) => {
      const importedTheme = parseMobileThemeFileJson(source);
      const next = addImportedMobileTheme(importedThemes, importedTheme);
      savePreferences({ importedThemes: next });
      updateThemePreference(importedTheme.id);
    },
    [importedThemes, savePreferences, updateThemePreference],
  );

  const removeImportedTheme = useCallback((removedThemeId: string) => {
    applyImportedThemeRemovalAtConfirmation(removedThemeId, importedThemeRemovalState.current);
  }, []);

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance: resolveAppearance(preferences),
      appearanceMode: themePreferences.appearanceMode,
      effectiveColorScheme,
      themeId: themePreferences.themeId,
      importedThemes,
      nativeSurfaceColors,
      isReady,
      setAppearanceMode,
      setThemeId,
      importThemeJson,
      removeImportedTheme,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
    }),
    [
      preferences,
      themePreferences,
      effectiveColorScheme,
      importedThemes,
      nativeSurfaceColors,
      isReady,
      setAppearanceMode,
      setThemeId,
      importThemeJson,
      removeImportedTheme,
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
