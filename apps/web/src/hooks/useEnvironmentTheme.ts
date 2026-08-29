import type { EnvironmentTheme } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Equal from "effect/Equal";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { primaryServerEnvironmentThemesAtom } from "../state/server";
import {
  createVividThemeColors,
  getDefaultThemeColors,
  getEnvironmentThemes,
  isReservedThemeId,
  lenientThemeColorOverrides,
  setEnvironmentThemes,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from "../themePalette";
import { useTheme } from "./useTheme";

function publishedThemeColors(
  theme: EnvironmentTheme,
  appearance: ThemeAppearance,
  colors: Readonly<Record<string, string>> | undefined,
): ThemeColors {
  // Seeds generate the base with the guided theme editor's generator, so a
  // desktop theme arrives as a coherent T3 Code palette rather than a foreign
  // one — but only for the appearance they describe. A variant builds on that
  // appearance's stock defaults: the generator follows the seed canvas's
  // luminance, so dark seeds would give a light variant unreadable colors.
  const base =
    appearance === theme.appearance && theme.canvas !== undefined && theme.accent !== undefined
      ? createVividThemeColors(appearance, theme.canvas, theme.accent)
      : getDefaultThemeColors(appearance);
  return { ...base, ...lenientThemeColorOverrides(colors ?? {}) };
}

/**
 * A published theme as the theme library renders it. Both published forms are
 * accepted: the seeded short form a desktop generates, and the standard
 * exported theme file the Download button produces — so any theme someone
 * shared can be dropped into the machine's themes directory as-is.
 */
export function environmentThemeDefinition(theme: EnvironmentTheme): ThemeDefinition {
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const [variantAppearance, variantColors] of Object.entries(theme.variants ?? {})) {
    if (variantAppearance === theme.appearance) continue;
    variants[variantAppearance as ThemeAppearance] = publishedThemeColors(
      theme,
      variantAppearance as ThemeAppearance,
      variantColors,
    );
  }

  return {
    id: theme.id,
    label: theme.name,
    appearance: theme.appearance,
    colors: publishedThemeColors(theme, theme.appearance, theme.colors),
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    // Only the pure seeded form is guided-generator output. An exported file,
    // or seeds carrying explicit role overrides, must open Duplicate in the
    // advanced editor -- the guided one regenerates from canvas and accent and
    // would discard whatever the machine hand-tuned.
    ...(theme.canvas !== undefined &&
    theme.accent !== undefined &&
    theme.colors === undefined &&
    theme.variants === undefined
      ? { managed: true }
      : {}),
  };
}

/**
 * Published palettes this client can render. Reserved ids are dropped here rather
 * than rendered: a published `t3-iris.json` would show this palette on its
 * card while "Use" resolved the built-in, and a published `dark.json` would
 * capture everyone whose stored preference is the stock `"dark"`.
 */
export function publishedThemeDefinitions(
  themes: ReadonlyArray<EnvironmentTheme>,
): ReadonlyArray<ThemeDefinition> {
  return themes
    .filter((theme) => {
      if (isReservedThemeId(theme.id)) return false;
      if (theme.canvas !== undefined && theme.accent !== undefined) return true;
      const otherAppearance = theme.appearance === "dark" ? "light" : "dark";
      return [theme.colors, theme.variants?.[otherAppearance]].some(
        (colors) =>
          colors !== undefined && Object.keys(lenientThemeColorOverrides(colors)).length > 0,
      );
    })
    .map(environmentThemeDefinition);
}

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
