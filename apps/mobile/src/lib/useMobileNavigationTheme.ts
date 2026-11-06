import { DarkTheme, DefaultTheme, type Theme } from "@react-navigation/native";
import { useMemo } from "react";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useUniwindTheme, useThemeFontFamilies } from "./useUniwindTheme";

export function useMobileNavigationTheme(surface: "screen" | "sidebar" = "screen"): Theme {
  const { themeAppearance: appearance } = useAppearancePreferences();
  const variables = useUniwindTheme();
  const fonts = useThemeFontFamilies();
  return useMemo(() => {
    const base = appearance === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      fonts: fonts.code
        ? {
            regular: { fontFamily: fonts.regular, fontWeight: "normal" },
            medium: { fontFamily: fonts.medium, fontWeight: "normal" },
            bold: { fontFamily: fonts.bold, fontWeight: "normal" },
            heavy: { fontFamily: fonts.bold, fontWeight: "normal" },
          }
        : base.fonts,
      colors: {
        ...base.colors,
        primary: variables["--color-primary-text"],
        background: variables[surface === "sidebar" ? "--color-drawer" : "--color-screen"],
        card: variables[surface === "sidebar" ? "--color-drawer" : "--color-sheet-solid"],
        text: variables[
          surface === "sidebar" ? "--color-drawer-foreground" : "--color-header-foreground"
        ],
        border:
          variables[surface === "sidebar" ? "--color-drawer-border" : "--color-header-border"],
        notification: variables["--color-danger-foreground"],
      },
    };
  }, [appearance, surface, variables, fonts]);
}
