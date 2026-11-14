import { appAtomRegistry } from "../rpc/atomRegistry";
import { themeEnvironmentIdAtom } from "../state/primaryEnvironment";
import { themeServerSettingsAtom } from "../state/server";
import { getThemeDefinition, singleAppearanceOf, subscribeToCustomThemes } from "../themePalette";
import { setAppearanceMode, setTheme } from "./useTheme";

const APPLIED_DEFAULT_THEME_STORAGE_PREFIX = "t3code:default-theme-applied:v2:";
const APPLIED_DEFAULT_APPEARANCE_STORAGE_PREFIX = "t3code:default-appearance-applied:v1:";

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

/** A single-appearance theme sets its own mode unless a mode was set with it or after it. */
export function themeSetsOwnMode(input: {
  readonly defaultThemeSetAt: string;
  readonly defaultAppearance: string;
  readonly defaultAppearanceSetAt: string;
}): boolean {
  // ISO timestamps from one server compare correctly as strings.
  return input.defaultAppearance === "" || input.defaultAppearanceSetAt < input.defaultThemeSetAt;
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
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  if (environmentId === null) return;
  const settings = appAtomRegistry.get(themeServerSettingsAtom);
  const { defaultTheme, defaultThemeSetAt } = settings;
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
  if (half !== null && themeSetsOwnMode(settings) && !setAppearanceMode(half)) return;
  writeAppliedGeneration(storageKey, generation);
}

/** Like the theme, the environment's mode applies once per set, then local choices win. */
function adoptDefaultAppearance(): void {
  if (typeof window === "undefined") return;
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  const { defaultAppearance, defaultAppearanceSetAt } =
    appAtomRegistry.get(themeServerSettingsAtom);
  const storageKey = `${APPLIED_DEFAULT_APPEARANCE_STORAGE_PREFIX}${environmentId}`;
  const generation = defaultThemeToApply({
    environmentId,
    defaultTheme: defaultAppearance,
    defaultThemeSetAt: defaultAppearanceSetAt,
    appliedGeneration: readAppliedGeneration(storageKey),
    resolves: true,
  });
  if (generation === null || defaultAppearance === "") return;
  if (setAppearanceMode(defaultAppearance)) writeAppliedGeneration(storageKey, generation);
}

function adoptDefaults(): void {
  adoptDefaultTheme();
  adoptDefaultAppearance();
}

/**
 * Applies the theme environment's default theme once per generation. Start it after the
 * environment theme sync so a first-run client adopting the environment's own theme finds it
 * already in the library; it re-checks when published or custom palettes change, so a theme
 * that resolves late still applies.
 */
export function startDefaultThemeAdoption(): () => void {
  const unsubscribes = [
    appAtomRegistry.subscribe(themeEnvironmentIdAtom, adoptDefaults),
    appAtomRegistry.subscribe(themeServerSettingsAtom, adoptDefaults),
    subscribeToCustomThemes(adoptDefaults),
  ];
  adoptDefaults();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
