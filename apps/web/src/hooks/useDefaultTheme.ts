import { useAtomValue } from "@effect/atom-react";
import { useEffect, useSyncExternalStore } from "react";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerSettingsAtom } from "../state/server";
import { getThemeDefinition, singleAppearanceOf, subscribeToCustomThemes } from "../themePalette";
import { useTheme } from "./useTheme";

const APPLIED_DEFAULT_THEME_STORAGE_PREFIX = "t3code:default-theme-applied:v2:";

/** Include set time so reasserting the same theme still applies. */
export function defaultThemeGeneration(theme: string, setAt: string): string {
  return setAt.length > 0 ? `${theme}@${setAt}` : theme;
}

export function defaultThemeToApply(input: {
  readonly environmentId: string | null;
  readonly defaultTheme: string;
  readonly defaultThemeSetAt: string;
  readonly appliedGeneration: string | null;
  readonly resolves: boolean;
}): string | null {
  if (input.environmentId === null || input.defaultTheme.length === 0) return null;
  const generation = defaultThemeGeneration(input.defaultTheme, input.defaultThemeSetAt);
  if (input.appliedGeneration === generation) return null;
  // Settings and palettes arrive independently; an unresolved theme must retry when palettes arrive.
  if (!input.resolves) return null;
  return generation;
}

function readAppliedGeneration(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeAppliedGeneration(storageKey: string, generation: string): void {
  try {
    window.localStorage.setItem(storageKey, generation);
  } catch {}
}

export function useDefaultThemeAdoption(): void {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const settings = useAtomValue(primaryServerSettingsAtom);
  const { defaultTheme, defaultThemeSetAt } = settings;
  const { setTheme, setAppearanceMode } = useTheme();
  const definition = useSyncExternalStore(
    subscribeToCustomThemes,
    () => getThemeDefinition(defaultTheme),
    () => null,
  );

  useEffect(() => {
    if (typeof window === "undefined" || environmentId === null) return;
    const storageKey = `${APPLIED_DEFAULT_THEME_STORAGE_PREFIX}${environmentId}`;
    const generation = defaultThemeToApply({
      environmentId,
      defaultTheme,
      defaultThemeSetAt,
      appliedGeneration: readAppliedGeneration(storageKey),
      resolves: definition !== null,
    });
    if (generation === null || definition === null) return;

    // A single-appearance theme needs both preference and appearance writes to take effect.
    if (!setTheme(defaultTheme)) return;
    const half = singleAppearanceOf(definition);
    // Only record adoption after both writes succeed, so an appearance failure remains retryable.
    if (half !== null && !setAppearanceMode(half)) return;
    writeAppliedGeneration(storageKey, generation);
  }, [environmentId, defaultTheme, defaultThemeSetAt, definition, setTheme, setAppearanceMode]);
}
