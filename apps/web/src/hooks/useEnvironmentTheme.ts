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
  // The generator follows canvas luminance; dark seeds would make a light variant unreadable.
  const base =
    appearance === theme.appearance && theme.canvas !== undefined && theme.accent !== undefined
      ? createVividThemeColors(appearance, theme.canvas, theme.accent)
      : getDefaultThemeColors(appearance);
  return { ...base, ...lenientThemeColorOverrides(colors ?? {}) };
}

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
    // Guided editing regenerates from seeds, so hand-tuned role overrides must use the advanced editor.
    ...(theme.canvas !== undefined &&
    theme.accent !== undefined &&
    theme.colors === undefined &&
    theme.variants === undefined
      ? { managed: true }
      : {}),
  };
}

/** Filters reserved ids that would select built-ins instead of the published palette. */
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

export function useEnvironmentThemeDefinitions(): ReadonlyArray<ThemeDefinition> {
  return useSyncExternalStore(subscribeToCustomThemes, getEnvironmentThemes, () => []);
}

export function useEnvironmentThemeSync(): void {
  const published = useAtomValue(primaryServerEnvironmentThemesAtom);
  const { refreshTheme } = useTheme();
  const lastPublished = useRef<ReadonlyArray<EnvironmentTheme> | null>(null);

  useEffect(() => {
    if (lastPublished.current !== null && Equal.equals(lastPublished.current, published)) return;
    lastPublished.current = published;

    // Active palettes are snapshots; changed colors require reapplying the theme.
    if (setEnvironmentThemes(publishedThemeDefinitions(published))) {
      refreshTheme({ preservePreview: true });
    }
  }, [published, refreshTheme]);
}
