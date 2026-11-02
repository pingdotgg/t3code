import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerSettingsAtom } from "../state/server";
import { getThemeDefinition, singleAppearanceOf, subscribeToCustomThemes } from "../themePalette";
import { setAppearanceMode, setTheme } from "./useTheme";

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
  // The setting and the palette it names arrive independently, so an id that
  // does not resolve yet is not a failure -- adoption re-checks when the
  // published set changes.
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

function adoptDefaultTheme(): void {
  if (typeof window === "undefined") return;
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) return;
  const { defaultTheme, defaultThemeSetAt } = appAtomRegistry.get(primaryServerSettingsAtom);
  const definition = getThemeDefinition(defaultTheme);
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
}

/**
 * Applies the primary environment's default theme once per generation. Start it after the
 * environment theme sync so a first-run client adopting the environment's own theme finds it
 * already in the library; it re-checks when published or custom palettes change, so a theme
 * that resolves late still applies.
 */
export function startDefaultThemeAdoption(): () => void {
  const unsubscribes = [
    appAtomRegistry.subscribe(primaryEnvironmentIdAtom, adoptDefaultTheme),
    appAtomRegistry.subscribe(primaryServerSettingsAtom, adoptDefaultTheme),
    subscribeToCustomThemes(adoptDefaultTheme),
  ];
  adoptDefaultTheme();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
