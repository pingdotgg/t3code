import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Uniwind } from "uniwind";

import {
  resolveAppearance,
  resolveAppearancePreferences,
  resolveTextScaleVariables,
  type AppearancePreferences,
  type ResolvedAppearance,
} from "../../../lib/appearancePreferences";
import { loadPreferences, savePreferencesPatch } from "../../../lib/storage";
import { cacheTerminalFontSize } from "../../terminal/terminalUiState";

interface AppearancePreferencesContextValue {
  /** Effective values with base-size derivation applied. Use this for rendering. */
  readonly appearance: ResolvedAppearance;
  readonly isReady: boolean;
  readonly setBaseFontSize: (value: number) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setTerminalFontSize: (value: number | null) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setCodeFontSize: (value: number | null) => void;
  readonly setCodeWordBreak: (value: boolean) => void;
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
  const [preferences, setPreferences] = useState<AppearancePreferences>(() =>
    resolveAppearancePreferences(null),
  );
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void loadPreferences()
      .then((stored) => {
        if (cancelled) {
          return;
        }

        const resolved = resolveAppearancePreferences(stored);
        setPreferences(resolved);
        cacheTerminalFontSize(resolveAppearance(resolved).terminalFontSize);
        setIsReady(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setIsReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyTextScaleVariables(preferences.baseFontSize);
  }, [preferences.baseFontSize]);

  const updatePreferences = useCallback((patch: Partial<AppearancePreferences>) => {
    setPreferences((current) => {
      const next = resolveAppearancePreferences({ ...current, ...patch });
      cacheTerminalFontSize(resolveAppearance(next).terminalFontSize);
      void savePreferencesPatch({
        baseFontSize: next.baseFontSize,
        terminalFontSize: next.terminalFontSize,
        codeFontSize: next.codeFontSize,
        codeWordBreak: next.codeWordBreak,
      }).catch(() => undefined);
      return next;
    });
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
      isReady,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
    }),
    [preferences, isReady, setBaseFontSize, setTerminalFontSize, setCodeFontSize, setCodeWordBreak],
  );

  return (
    <AppearancePreferencesContext.Provider value={value}>
      {props.children}
    </AppearancePreferencesContext.Provider>
  );
}

export function useAppearancePreferences(): AppearancePreferencesContextValue {
  const context = useContext(AppearancePreferencesContext);
  if (!context) {
    throw new Error("useAppearancePreferences must be used within AppearancePreferencesProvider");
  }
  return context;
}
