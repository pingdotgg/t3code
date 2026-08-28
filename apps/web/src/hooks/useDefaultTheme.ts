import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerSettingsAtom } from "../state/server";
import { getThemeDefinition } from "../themePalette";
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
function defaultThemeGeneration(theme: string, setAt: string): string {
  return setAt.length > 0 ? `${theme}@${setAt}` : theme;
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
  const { setTheme } = useTheme();
  // Re-runs adoption when a late-arriving published theme makes the
  // requested id resolvable.
  const environmentThemes = useEnvironmentThemeDefinitions();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (environmentId === null || defaultTheme.length === 0) return;
    const storageKey = `${APPLIED_DEFAULT_THEME_STORAGE_PREFIX}${environmentId}`;
    const generation = defaultThemeGeneration(defaultTheme, defaultThemeSetAt);
    if (readAppliedGeneration(storageKey) === generation) return;
    if (getThemeDefinition(defaultTheme) === null) return;
    if (setTheme(defaultTheme)) writeAppliedGeneration(storageKey, generation);
  }, [environmentId, defaultTheme, defaultThemeSetAt, environmentThemes, setTheme]);
}
