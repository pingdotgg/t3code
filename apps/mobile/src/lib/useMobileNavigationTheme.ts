import { DarkTheme, DefaultTheme, type Theme } from "@react-navigation/native";
import { useMemo } from "react";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useUniwindTheme } from "./useUniwindTheme";

/**
 * React Navigation requires a JS theme object. Derive it from the same palette
 * source as Uniwind instead of subscribing the app root to CSS variables. The
 * preferences provider applies the registered Uniwind theme first, then
 * publishes this matching navigation palette through React.
 */
export function useMobileNavigationTheme(surface: "screen" | "sidebar" = "screen"): Theme {
  const { themeAppearance: appearance } = useAppearancePreferences();
  const variables = useUniwindTheme();
  return useMemo(() => {
    const base = appearance === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
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
  }, [appearance, surface, variables]);
}
