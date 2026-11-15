import { useAtomValue } from "@effect/atom-react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { appAtomRegistry, subscribeAtomChanges } from "../rpc/atomRegistry";
import {
  desktopLocalThemesAtom,
  environmentThemeDefinitionsAtom,
  storePublishedEnvironmentThemes,
  type ThemeDefinition,
} from "../themePalette";
import { refreshTheme } from "./useTheme";

export function useEnvironmentThemeDefinitions(): ReadonlyArray<ThemeDefinition> {
  return useAtomValue(environmentThemeDefinitionsAtom);
}

/**
 * The palette is painted from a snapshot taken when the theme last changed, so new colors
 * only land if the active theme is re-applied.
 */
export function startEnvironmentThemeRepaint(): () => void {
  return subscribeAtomChanges(environmentThemeDefinitionsAtom, (definitions) => {
    storePublishedEnvironmentThemes(definitions);
    refreshTheme({ preservePreview: true });
  });
}

/**
 * Conn: without a local environment there is no primary server to publish themes, so the
 * desktop app reads this machine's themes folder itself and publishes it in their place.
 */
export function startDesktopLocalThemes(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!isLocalEnvironmentDisabled() || bridge?.getLocalThemes === undefined) return () => {};
  let active = true;
  // Subscribed first, so an edit landing during the initial read is not lost.
  const unsubscribe = bridge.onLocalThemesChanged?.((next) => {
    active = false;
    appAtomRegistry.set(desktopLocalThemesAtom, next);
  });
  bridge.getLocalThemes().then(
    (next) => {
      if (active) appAtomRegistry.set(desktopLocalThemesAtom, next);
    },
    () => {},
  );
  return () => {
    active = false;
    unsubscribe?.();
  };
}
