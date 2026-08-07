import { DarkTheme, DefaultTheme } from "@react-navigation/native";
import type { ThemeAppearance, ThemeColors } from "@t3tools/themes";

import { getDefaultMobileCSSVariables } from "./mobileTheme";

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
    const defaultVariables = getDefaultMobileCSSVariables(appearance);
    return {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        background: defaultVariables["--color-screen"] ?? baseTheme.colors.background,
        card: defaultVariables["--color-sheet"] ?? baseTheme.colors.card,
      },
    };
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
