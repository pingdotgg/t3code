import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerSettingsAtom } from "../state/server";
import { getThemeDefinition, singleAppearanceOf } from "../themePalette";
import { useEnvironmentThemeDefinitions } from "./useEnvironmentTheme";
import { useTheme } from "./useTheme";

/**
 * Scoped per environment: each machine's `t3 theme set` is its own act, so
 * hopping between primary environments neither replays one environment's
 * theme over the user's pick nor swallows another's.
 */
const APPLIED_DEFAULT_THEME_STORAGE_PREFIX = "t3code:default-theme-applied:v2:";

/**
 * One generation per set: keyed on when the theme was set, not just its
 * value, so re-asserting the same theme still acts. Environments provisioned
 * by builds without the timestamp degrade to applying once per value.
 */
export function defaultThemeGeneration(theme: string, setAt: string): string {
  return setAt.length > 0 ? `${theme}@${setAt}` : theme;
}

/**
 * The generation to apply, or null to leave this client alone. Pure so the
 * rule -- apply once per set, never replay one already applied, wait for a
 * theme that has not arrived yet -- can be tested without a renderer.
 */
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
  // does not resolve yet is not a failure -- the effect runs again when the
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
  } catch {
    // Unrecordable means the next config event applies again; harmless.
  }
}

/**
 * Applies the environment's theme (`t3 theme set <id>`). Each set switches
 * this client once — live when connected, on the next connect otherwise —
 * and then steps aside: a theme the user picks in Settings afterwards wins
 * until the environment's theme is set again. The environment's own published
 * themes are valid targets, which is why this waits for an id that does not
 * resolve yet — the setting and the palette it names arrive independently.
 */
export function useDefaultThemeAdoption(): void {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const settings = useAtomValue(primaryServerSettingsAtom);
  const { defaultTheme, defaultThemeSetAt } = settings;
  const { setTheme, setAppearanceMode } = useTheme();
  // Re-runs adoption when a late-arriving published theme makes the
  // requested id resolvable.
  const environmentThemes = useEnvironmentThemeDefinitions();

  useEffect(() => {
    if (typeof window === "undefined" || environmentId === null) return;
    const storageKey = `${APPLIED_DEFAULT_THEME_STORAGE_PREFIX}${environmentId}`;
    const definition = getThemeDefinition(defaultTheme);
    const generation = defaultThemeToApply({
      environmentId,
      defaultTheme,
      defaultThemeSetAt,
      appliedGeneration: readAppliedGeneration(storageKey),
      resolves: definition !== null,
    });
    if (generation === null || definition === null) return;

    // Deliberately not the card's rule. Clicking a card is a user choosing one
    // half of their own mix; a set theme is the environment saying what this
    // client opens on, so it takes the base preference and, for a
    // single-appearance theme, the matching mode -- otherwise a dark-only
    // theme on a light client is recorded as applied while nothing changes.
    if (!setTheme(defaultTheme)) return;
    const half = singleAppearanceOf(definition);
    // Recorded only once both land: marking the generation applied while the
    // appearance switch failed would leave a dark-only theme rendering its
    // light half with no retry.
    if (half !== null && !setAppearanceMode(half)) return;
    writeAppliedGeneration(storageKey, generation);
  }, [
    environmentId,
    defaultTheme,
    defaultThemeSetAt,
    environmentThemes,
    setTheme,
    setAppearanceMode,
  ]);
}
