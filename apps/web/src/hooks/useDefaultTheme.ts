import { preferencesSync } from "../clientProfile/preferencesSync";
import { themeProfileValuesForDefault } from "../clientProfile/themeSource";
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

export function defaultThemeChangedAt(setAt: string): number {
  const parsed = Date.parse(setAt);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
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

async function adoptDefaultThemeOnce(): Promise<void> {
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

  const values = themeProfileValuesForDefault(defaultTheme, themeSetsOwnMode(settings));
  if (values === null) return;
  const result = await preferencesSync.adoptExternalChange({
    environmentId,
    values,
    changedAt: defaultThemeChangedAt(defaultThemeSetAt),
  });
  if (result === "waiting") return;
  if (result === "off") {
    // A single-appearance theme needs both preference and appearance writes to take effect.
    if (!setTheme(defaultTheme)) return;
    const half = singleAppearanceOf(definition);
    // Only record adoption after both writes succeed, so an appearance failure remains retryable.
    if (half !== null && themeSetsOwnMode(settings) && !setAppearanceMode(half)) return;
  }
  writeAppliedGeneration(storageKey, generation);
}

/** Like the theme, the environment's mode applies once per set, then local choices win. */
async function adoptDefaultAppearanceOnce(): Promise<void> {
  if (typeof window === "undefined") return;
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  if (environmentId === null) return;
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
  const result = await preferencesSync.adoptExternalChange({
    environmentId,
    values: { themeMode: defaultAppearance },
    changedAt: defaultThemeChangedAt(defaultAppearanceSetAt),
  });
  if (result === "waiting") return;
  if (result === "off" && !setAppearanceMode(defaultAppearance)) return;
  writeAppliedGeneration(storageKey, generation);
}

let adopting = false;
let rerunQueued = false;

async function adoptDefaults(): Promise<void> {
  if (adopting) {
    rerunQueued = true;
    return;
  }
  adopting = true;
  try {
    do {
      rerunQueued = false;
      try {
        await adoptDefaultThemeOnce();
        await adoptDefaultAppearanceOnce();
      } catch (cause) {
        console.warn("Default theme adoption failed", cause);
      }
    } while (rerunQueued);
  } finally {
    adopting = false;
  }
}

/**
 * Applies the theme environment's default theme once per generation. Start it after the
 * environment theme sync so a first-run client adopting the environment's own theme finds it
 * already in the library; it re-checks when published or custom palettes change, so a theme
 * that resolves late still applies.
 */
export function startDefaultThemeAdoption(): () => void {
  const adopt = () => void adoptDefaults();
  const unsubscribes = [
    appAtomRegistry.subscribe(themeEnvironmentIdAtom, adopt),
    appAtomRegistry.subscribe(themeServerSettingsAtom, adopt),
    appAtomRegistry.subscribe(preferencesSync.statusAtom, adopt),
    subscribeToCustomThemes(adopt),
  ];
  adopt();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
