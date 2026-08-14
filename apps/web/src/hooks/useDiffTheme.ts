import { useMemo, useSyncExternalStore } from "react";

import { useTheme } from "./useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import {
  getThemePreviewAppearance,
  getThemePreviewRevision,
  resolveThemeHalf,
  subscribeToThemePreview,
  THEME_PREVIEW_ID,
  type ThemeAppearance,
} from "../themePalette";

export function useDiffTheme(): { appearance: ThemeAppearance; themeName: DiffThemeName } {
  const { theme, resolvedTheme, themeHalves } = useTheme();
  const previewRevision = useSyncExternalStore(
    subscribeToThemePreview,
    getThemePreviewRevision,
    () => 0,
  );

  return useMemo(() => {
    void previewRevision;
    const previewAppearance = getThemePreviewAppearance();
    if (previewAppearance) {
      return {
        appearance: previewAppearance,
        themeName: resolveDiffThemeName(THEME_PREVIEW_ID, previewAppearance),
      };
    }
    return {
      appearance: resolvedTheme,
      themeName: resolveDiffThemeName(
        resolveThemeHalf(theme, themeHalves, resolvedTheme),
        resolvedTheme,
      ),
    };
  }, [previewRevision, resolvedTheme, theme, themeHalves]);
}

export function useDiffThemeName(): DiffThemeName {
  return useDiffTheme().themeName;
}
