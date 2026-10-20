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
import {
  normalizeFontSelections,
  reconcileInstalledFonts,
  normalizeReplyEmphasisWeights,
  resolveReplyEmphasis,
  type ReplyEmphasisWeight,
  resolveMobileFonts,
  type MobileFontRole,
  type MobileFontSelections,
  type InstalledMobileFont,
} from "../../../lib/mobileFonts";
import { resolveInstalledFonts } from "../../../native/installed-fonts";
import { normalizeBaseFontSize } from "../../../lib/appearancePreferences";
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
  readonly fonts: ReturnType<typeof resolveMobileFonts>;
  readonly fontSelections: MobileFontSelections;
  readonly installedFonts: ReadonlyMap<string, InstalledMobileFont>;
  readonly unavailableFonts: readonly string[];
  readonly replyFontSize: number;
  readonly replyEmphasisWeight: ReplyEmphasisWeight | undefined;
  readonly replyEmphasisFontFamily: string;
  readonly setReplyEmphasisWeight: (weight: ReplyEmphasisWeight | undefined) => void;
  readonly composerFontSize: number;
  readonly customReplyFontSize: boolean;
  readonly customComposerFontSize: boolean;
  readonly setFontSelection: (role: MobileFontRole, selection: string) => void;
  readonly setReplyFontSize: (size: number | null) => void;
  readonly setComposerFontSize: (size: number | null) => void;
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
  const fontSelections = useMemo(
    () => normalizeFontSelections(storedPreferences?.fontSelections),
    [storedPreferences?.fontSelections],
  );
  const selectedFontNames = useMemo(
    () => [
      ...new Set(
        Object.values(fontSelections)
          .filter((selection) => selection.startsWith("installed:"))
          .map((selection) => selection.slice(10)),
      ),
    ],
    [fontSelections],
  );
  const [installedFonts, setInstalledFonts] = useState<ReadonlyMap<string, InstalledMobileFont>>(
    new Map(),
  );
  const [unavailableFonts, setUnavailableFonts] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const updateUnavailableFonts = (missing: readonly string[]) => {
      setUnavailableFonts((previous) =>
        previous.length === missing.length &&
        previous.every((name, index) => name === missing[index])
          ? previous
          : missing,
      );
    };
    const refresh = () => {
      generation = generation + 1;
      const request = generation;
      void resolveInstalledFonts(selectedFontNames)
        .then((resolved) => {
          if (cancelled || request !== generation) return;
          const available = new Map(resolved.map((font) => [font.name, font]));
          setInstalledFonts((previous) => reconcileInstalledFonts(previous, available));
          updateUnavailableFonts(selectedFontNames.filter((name) => !available.has(name)));
        })
        .catch(() => {
          if (cancelled || request !== generation) return;
          setInstalledFonts((previous) => (previous.size ? new Map() : previous));
          updateUnavailableFonts(selectedFontNames);
        });
    };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [selectedFontNames]);
  const fonts = useMemo(
    () => resolveMobileFonts(fontSelections, installedFonts, Platform.OS),
    [fontSelections, installedFonts],
  );
  const replyEmphasisWeight = normalizeReplyEmphasisWeights(
    storedPreferences?.replyEmphasisWeights,
  )[fonts.reply.regular];
  const replyEmphasisFontFamily = resolveReplyEmphasis(fonts.reply, replyEmphasisWeight);
  const fontVariables = useMemo(
    () => ({
      ...themeVariables,
      "--font-sans": fonts.interface.regular,
      "--font-medium": fonts.interface.medium,
      "--font-bold": fonts.interface.bold,
    }),
    [themeVariables, fonts.interface],
  );
  const replyFontSize = normalizeBaseFontSize(storedPreferences?.replyFontSize ?? baseFontSize);
  const composerFontSize = normalizeBaseFontSize(
    storedPreferences?.composerFontSize ?? baseFontSize,
  );
  const customReplyFontSize = storedPreferences?.replyFontSize != null;
  const customComposerFontSize = storedPreferences?.composerFontSize != null;
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

      // Clear a forced native appearance before publishing System. The
      // resulting useColorScheme notification still sees the previous forced
      // preference, so React batches the actual system palette into the one
      // urgent preference commit below.
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
  const setFontSelection = useCallback(
    (role: MobileFontRole, selection: string) => {
      savePreferences({
        transform: (current) => ({
          fontSelections: { ...normalizeFontSelections(current.fontSelections), [role]: selection },
        }),
      });
    },
    [savePreferences],
  );
  const setReplyEmphasisWeight = useCallback(
    (weight: ReplyEmphasisWeight | undefined) => {
      savePreferences({
        transform: (current) => {
          const next = { ...normalizeReplyEmphasisWeights(current.replyEmphasisWeights) };
          if (weight === undefined) delete next[fonts.reply.regular];
          else next[fonts.reply.regular] = weight;
          return { replyEmphasisWeights: next };
        },
      });
    },
    [fonts.reply.regular, savePreferences],
  );
  const setReplyFontSize = useCallback(
    (size: number | null) =>
      updatePreferences({ replyFontSize: size === null ? null : normalizeBaseFontSize(size) }),
    [updatePreferences],
  );
  const setComposerFontSize = useCallback(
    (size: number | null) =>
      updatePreferences({ composerFontSize: size === null ? null : normalizeBaseFontSize(size) }),
    [updatePreferences],
  );

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance,
      fonts,
      fontSelections,
      installedFonts,
      unavailableFonts,
      replyFontSize,
      replyEmphasisWeight,
      replyEmphasisFontFamily,
      setReplyEmphasisWeight,
      composerFontSize,
      customReplyFontSize,
      customComposerFontSize,
      setFontSelection,
      setReplyFontSize,
      setComposerFontSize,
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
      fonts,
      fontSelections,
      installedFonts,
      unavailableFonts,
      replyFontSize,
      replyEmphasisWeight,
      replyEmphasisFontFamily,
      setReplyEmphasisWeight,
      composerFontSize,
      customReplyFontSize,
      customComposerFontSize,
      setFontSelection,
      setReplyFontSize,
      setComposerFontSize,
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
        <ScopedVariables variables={fontVariables}>{props.children}</ScopedVariables>
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
