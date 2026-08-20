import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";

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
  DEFAULT_MOBILE_THEME_ID,
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
import {
  addImportedMobileTheme,
  parseMobileThemeFileJson,
  sanitizeImportedMobileThemes,
  type ImportedMobileTheme,
} from "../../../lib/mobileThemeFile";
import {
  useUpdateAppearanceModePreference,
  useUpdateThemeIdPreference,
} from "../../../state/synced-client-preferences";
import { cacheTerminalFontSize } from "../../terminal/terminalUiState";

interface AppearancePreferencesContextValue {
  /** Effective values with base-size derivation applied. Use this for rendering. */
  readonly appearance: ResolvedAppearance;
  readonly themeId: MobileThemeId;
  readonly themeIds: MobileThemeIds;
  readonly themeMode: MobileThemeMode;
  readonly themeAppearance: MobileThemeAppearance;
  readonly importedThemes: ReadonlyArray<ImportedMobileTheme>;
  readonly isReady: boolean;
  readonly setThemeIdForAppearance: (
    appearance: MobileThemeAppearance,
    value: MobileThemeId,
  ) => void;
  readonly setThemeIdForBothAppearances: (value: MobileThemeId) => void;
  readonly setThemeMode: (value: MobileThemeMode) => void;
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
  readonly themeIds: MobileThemeIds;
  readonly saveImportedThemes: (themes: ReadonlyArray<ImportedMobileTheme>) => void;
  readonly publishThemeId: (appearance: MobileThemeAppearance, themeId: MobileThemeId) => void;
}

export function applyImportedThemeRemovalAtConfirmation(
  removedThemeId: string,
  current: ImportedThemeRemovalConfirmationState,
): void {
  if (!current.importedThemes.some((theme) => theme.id === removedThemeId)) return;
  current.saveImportedThemes(current.importedThemes.filter((theme) => theme.id !== removedThemeId));
  if (current.themeIds.light === removedThemeId) {
    current.publishThemeId("light", DEFAULT_MOBILE_THEME_ID);
  }
  if (current.themeIds.dark === removedThemeId) {
    current.publishThemeId("dark", DEFAULT_MOBILE_THEME_ID);
  }
}

/**
 * Injects palette and text-scale variables into both adaptive stylesheets.
 * Updating the active sheet last lets the visible app settle in one pass.
 */
function applyAppearanceVariables(
  baseFontSize: number,
  themeIds: MobileThemeIds,
  importedThemes: ReadonlyArray<ImportedMobileTheme>,
) {
  const textVariables = resolveTextScaleVariables(baseFontSize);
  const currentTheme = Uniwind.currentTheme;
  const activeAppearance =
    currentTheme === "light" || currentTheme === "dark" ? currentTheme : null;

  for (const theme of ["light", "dark"] as const) {
    const variables = {
      ...getMobileThemeVariables(themeIds[theme], theme, null, importedThemes),
      ...textVariables,
    };
    if (theme !== activeAppearance) {
      Uniwind.updateCSSVariables(theme, variables);
    }
  }
  if (activeAppearance !== null) {
    Uniwind.updateCSSVariables(activeAppearance, {
      ...getMobileThemeVariables(
        themeIds[activeAppearance],
        activeAppearance,
        null,
        importedThemes,
      ),
      ...textVariables,
    });
  }
}

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const publishAppearanceMode = useUpdateAppearanceModePreference();
  const publishThemeId = useUpdateThemeIdPreference();
  const systemColorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const storedPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : null;
  const preferences = useMemo(
    () => resolveAppearancePreferences(storedPreferences),
    [storedPreferences],
  );
  const themeMode = normalizeMobileThemeMode(storedPreferences?.themeMode);
  const importedThemes = useMemo(
    () => sanitizeImportedMobileThemes(storedPreferences?.importedThemes),
    [storedPreferences?.importedThemes],
  );
  const themeAppearance = themeMode === "system" ? systemColorScheme : themeMode;
  const themeIds = useMemo(
    () => resolveMobileThemeIds(storedPreferences ?? {}, importedThemes),
    [importedThemes, storedPreferences],
  );
  const themeId = themeIds[themeAppearance];
  const isReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const importedThemeRemovalState = useRef<ImportedThemeRemovalConfirmationState>({
    importedThemes,
    themeIds,
    saveImportedThemes: (themes) => savePreferences({ importedThemes: themes }),
    publishThemeId,
  });
  importedThemeRemovalState.current = {
    importedThemes,
    themeIds,
    saveImportedThemes: (themes) => savePreferences({ importedThemes: themes }),
    publishThemeId,
  };

  useLayoutEffect(() => {
    applyAppearanceVariables(preferences.baseFontSize, themeIds, importedThemes);
    Uniwind.setTheme(themeMode);
    cacheTerminalFontSize(resolveAppearance(preferences).terminalFontSize);
  }, [importedThemes, preferences, themeIds, themeMode]);

  const updatePreferences = useCallback(
    (patch: Partial<Preferences>) => {
      savePreferences(patch);
    },
    [savePreferences],
  );

  const setThemeIdForAppearance = useCallback(
    (appearance: MobileThemeAppearance, value: MobileThemeId) => {
      const patch = createMobileThemeSelectionPatch(themeIds, themeAppearance, appearance, value);
      updatePreferences({ themeId: patch.themeId });
      publishThemeId(appearance, value);
    },
    [publishThemeId, themeAppearance, themeIds, updatePreferences],
  );

  const setThemeIdForBothAppearances = useCallback(
    (value: MobileThemeId) => {
      updatePreferences({ themeId: createMobileThemePairPatch(value).themeId });
      publishThemeId("light", value);
      publishThemeId("dark", value);
    },
    [publishThemeId, updatePreferences],
  );

  const setThemeMode = useCallback(
    (value: MobileThemeMode) => {
      publishAppearanceMode(value);
    },
    [publishAppearanceMode],
  );

  const importThemeJson = useCallback(
    (source: string) => {
      const imported = parseMobileThemeFileJson(source);
      const next = addImportedMobileTheme(importedThemes, imported);
      savePreferences({ importedThemes: next });
      publishThemeId(imported.appearance, imported.id);
    },
    [importedThemes, publishThemeId, savePreferences],
  );

  const removeImportedTheme = useCallback((removedThemeId: string) => {
    applyImportedThemeRemovalAtConfirmation(removedThemeId, importedThemeRemovalState.current);
  }, []);

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
      importedThemes,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      setThemeMode,
      importThemeJson,
      removeImportedTheme,
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
      importedThemes,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      setThemeMode,
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
