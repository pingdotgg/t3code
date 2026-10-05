import type { MobileThemeMode, MobileThemeVariables } from "../lib/mobileTheme";

export interface WidgetPalette {
  background: string;
  foreground: string;
  secondary: string;
  accent: string;
  track: string;
  danger: string;
}

export interface WidgetTheme {
  mode: MobileThemeMode;
  light: WidgetPalette;
  dark: WidgetPalette;
}

/** Publish native colors, not CSS variables, to the isolated widget runtime. */
export function createWidgetTheme(
  mode: MobileThemeMode,
  palettes: Readonly<Record<"light" | "dark", MobileThemeVariables>>,
): WidgetTheme {
  const palette = (variables: MobileThemeVariables): WidgetPalette => ({
    background: variables["--color-card"],
    foreground: variables["--color-foreground"],
    secondary: variables["--color-foreground-secondary"],
    accent: variables["--color-primary"],
    track: variables["--color-subtle"],
    danger: variables["--color-danger-foreground"],
  });
  return { mode, light: palette(palettes.light), dark: palette(palettes.dark) };
}
