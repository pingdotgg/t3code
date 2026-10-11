import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { useMemo, useSyncExternalStore } from "react";

import { appearanceFontStack } from "../appearanceFonts";
import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeColorVariable,
  resolveThemeHalf,
  subscribeToCustomThemes,
  subscribeToThemePreview,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { useClientSettings } from "./useSettings";
import { useTheme } from "./useTheme";

/** The palette `applyTheme` paints for a preference, or the stock look when no theme applies. */
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

const HTML_RENDER_VARIABLES = Object.keys(
  htmlRenderTheme(getStandardThemeColors("light"), "light").variables,
).filter((variable) => variable !== "--font-sans" && variable !== "--font-mono");

const HTML_RENDER_APP_ALIASES: Readonly<Record<string, string>> = {
  "--accent-surface": "--accent",
  "--accent-surface-foreground": "--accent-foreground",
  "--destructive-surface": "--error-surface",
};

/** A primitive snapshot keeps external-store reads stable while tracking the painted CSS. */
function readPaintedTheme(): string {
  if (typeof document === "undefined") return "";
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const variables: Record<string, string> = {};
  for (const variable of HTML_RENDER_VARIABLES) {
    // HTML's accent is the brand color; the app's --accent is a hover surface.
    const appVariable =
      variable === "--accent" || variable === "--chart-1"
        ? getThemeColorVariable("accent")
        : variable === "--accent-foreground"
          ? getThemeColorVariable("accentForeground")
          : variable;
    const value =
      styles.getPropertyValue(appVariable).trim() ||
      styles.getPropertyValue(HTML_RENDER_APP_ALIASES[variable] ?? appVariable).trim();
    if (value) variables[variable] = value;
  }
  return JSON.stringify({
    appearance: root.classList.contains("dark") ? "dark" : "light",
    variables,
  });
}

/** The app's active theme and fonts, as handed to agent HTML renders. Stable until one changes. */
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
  const paintedTheme = useSyncExternalStore(subscribeToThemePreview, readPaintedTheme, () => "");
  return useMemo(() => {
    const painted = paintedTheme
      ? (JSON.parse(paintedTheme) as {
          appearance: ThemeAppearance;
          variables: Record<string, string>;
        })
      : null;
    const base = htmlRenderTheme(colors, painted?.appearance ?? resolvedTheme, {
      sans: appearanceFontStack(sans, HTML_RENDER_DEFAULT_FONTS.sans),
      mono: appearanceFontStack(mono, HTML_RENDER_DEFAULT_FONTS.mono),
    });
    if (!painted) return base;
    return {
      ...base,
      appearance: painted.appearance,
      variables: { ...base.variables, ...painted.variables },
    };
  }, [colors, resolvedTheme, sans, mono, paintedTheme]);
}
