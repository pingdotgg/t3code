import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { useSyncExternalStore } from "react";

import { appearanceFontStack } from "../appearanceFonts";
import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  subscribeToCustomThemes,
  themeColorToHex,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { useClientSettings } from "./useSettings";
import { useTheme } from "./useTheme";

function resolveActiveThemeColors(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
) {
  const definition = getThemeDefinition(resolveThemeHalf(theme, halves, appearance));
  return definition === null
    ? getStandardThemeColors(appearance)
    : (getThemeColorsForMode(definition, appearance) ?? definition.colors);
}

export function useHtmlRenderTheme() {
  const { theme, resolvedTheme, themeHalves } = useTheme();
  // Custom and published palettes can be edited in place, under an unchanged preference.
  const colors = useSyncExternalStore(
    subscribeToCustomThemes,
    () => resolveActiveThemeColors(theme, themeHalves, resolvedTheme),
    () => getStandardThemeColors(resolvedTheme),
  );
  const sans = useClientSettings((settings) => settings.fontFamilySans);
  const mono = useClientSettings((settings) => settings.fontFamilyCode);
  const monospace = useClientSettings((settings) => settings.fontMonospace);
  const monoStack = appearanceFontStack(mono, HTML_RENDER_DEFAULT_FONTS.mono);
  return htmlRenderTheme(
    Object.fromEntries(
      Object.entries(colors).map(([role, color]) => [role, themeColorToHex(color) ?? color]),
    ) as typeof colors,
    resolvedTheme,
    {
      sans: monospace ? monoStack : appearanceFontStack(sans, HTML_RENDER_DEFAULT_FONTS.sans),
      mono: monoStack,
    },
  );
}
