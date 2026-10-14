import type { EnvironmentTheme } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Equal from "effect/Equal";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { primaryServerEnvironmentThemesAtom } from "../state/server";
import {
  getEnvironmentThemes,
  setEnvironmentThemes,
  subscribeToCustomThemes,
  type ThemeDefinition,
} from "../themePalette";
import { useTheme } from "./useTheme";

export { environmentThemeDefinition, publishedThemeDefinitions } from "../publishedTheme";
import { publishedThemeDefinitions } from "../publishedTheme";

/** The published themes as library entries; empty while none are published. */
export function useEnvironmentThemeDefinitions(): ReadonlyArray<ThemeDefinition> {
  return useSyncExternalStore(subscribeToCustomThemes, getEnvironmentThemes, () => []);
}

/**
 * Keeps the machine's published themes in the theme library for as long as
 * the primary environment publishes them. A client with a published theme
 * selected retints the moment the machine rewrites it; everyone else just
 * gains cards in the theme library.
 */
export function useEnvironmentThemeSync(): void {
  const published = useAtomValue(primaryServerEnvironmentThemesAtom);
  const { refreshTheme } = useTheme();
  const lastPublished = useRef<ReadonlyArray<EnvironmentTheme> | null>(null);

  useEffect(() => {
    // Every reconnect snapshot delivers a fresh but usually identical array;
    // regenerating palettes and repainting the document for it is exactly the
    // wasted-frame class this codebase audits for.
    if (lastPublished.current !== null && Equal.equals(lastPublished.current, published)) return;
    lastPublished.current = published;

    // The palette is painted from a snapshot taken when the theme last
    // changed, so new colors only land if the active theme is re-applied.
    if (setEnvironmentThemes(publishedThemeDefinitions(published))) {
      refreshTheme({ preservePreview: true });
    }
  }, [published, refreshTheme]);
}
