import { DarkTheme, DefaultTheme, type Theme } from "@react-navigation/native";
import { useMemo } from "react";

import type { MobileThemeAppearance } from "./mobileTheme";
import { useThemeColor } from "./useThemeColor";

export function useMobileNavigationTheme(appearance: MobileThemeAppearance): Theme {
  const primary = String(useThemeColor("--color-primary"));
  const background = String(useThemeColor("--color-screen"));
  const card = String(useThemeColor("--color-sheet-solid"));
  const text = String(useThemeColor("--color-foreground"));
  const border = String(useThemeColor("--color-header-border"));
  const notification = String(useThemeColor("--color-danger-foreground"));

  return useMemo(() => {
    const base = appearance === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: { ...base.colors, primary, background, card, text, border, notification },
    };
  }, [appearance, background, border, card, notification, primary, text]);
}
