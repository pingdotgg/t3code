import { DarkTheme, DefaultTheme } from "@react-navigation/native";
import type { ThemeAppearance, ThemeColors } from "@t3tools/themes";

/**
 * React Navigation owns native headers and sheet chrome separately from
 * Uniwind. Keep its semantic colors on the same active palette so a theme
 * change updates both layers in the same render.
 */
export function createMobileNavigationTheme(
  appearance: ThemeAppearance,
  themeColors: ThemeColors | null,
) {
  const baseTheme = appearance === "dark" ? DarkTheme : DefaultTheme;
  if (themeColors === null) {
    return baseTheme;
  }

  return {
    ...baseTheme,
    dark: appearance === "dark",
    colors: {
      ...baseTheme.colors,
      primary: themeColors.accent,
      background: themeColors.canvas,
      card: themeColors.surfaceRaised,
      text: themeColors.text,
      border: themeColors.border,
      notification: themeColors.error,
    },
  };
}
