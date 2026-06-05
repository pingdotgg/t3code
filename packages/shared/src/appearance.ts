import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
  type ThemeDocument,
  type ThemeMode,
} from "@t3tools/contracts";

import { BUILT_IN_THEMES } from "./appearance/themes.ts";

export type AppearanceCssVariables = Readonly<Record<string, string>>;

export const BUILT_IN_APPEARANCE_THEMES: ReadonlyArray<ThemeDocument> = BUILT_IN_THEMES;

export function getAppearanceThemes(mode?: ThemeMode): ReadonlyArray<ThemeDocument> {
  const themes =
    mode === undefined
      ? BUILT_IN_APPEARANCE_THEMES
      : BUILT_IN_APPEARANCE_THEMES.filter((theme) => theme.mode === mode);
  return [...themes].sort((left, right) => left.name.localeCompare(right.name));
}

export function getAppearanceThemeById(id: string): ThemeDocument | undefined {
  return BUILT_IN_APPEARANCE_THEMES.find((theme) => theme.id === id);
}

export function resolveAppearanceTheme(settings: AppearanceSettings): ThemeDocument {
  return (
    getAppearanceThemeById(settings.themeId) ??
    getAppearanceThemeById(DEFAULT_APPEARANCE_SETTINGS.themeId) ??
    getAppearanceThemes()[0]!
  );
}

function alpha(hex: string, opacityPercent: number): string {
  return `color-mix(in srgb, ${hex} ${opacityPercent}%, transparent)`;
}

function mix(hex: string, other: string, percent: number): string {
  return `color-mix(in srgb, ${hex} ${percent}%, ${other})`;
}

function slot(theme: ThemeDocument, key: keyof ThemeDocument["semanticSlots"], fallback: string) {
  return theme.semanticSlots[key] ?? fallback;
}

/**
 * Derive CSS custom properties from a resolved theme document.
 * The caller is responsible for resolving which theme to use.
 */
export function deriveAppearanceCssVariables(theme: ThemeDocument): AppearanceCssVariables {
  const accent = theme.accentSeed;
  const neutral = theme.neutralSeed ?? theme.foregroundSeed;
  const dark = theme.mode === "dark";
  const background = theme.backgroundSeed;
  const foreground = theme.foregroundSeed;
  const surfaceMix = dark ? "#ffffff" : "#000000";
  const surfacePercent = dark ? 97 : 98;
  const quietOpacity = dark ? 8 : 5;

  return {
    "--background": slot(theme, "background", background),
    "--app-chrome-background": slot(theme, "appChromeBackground", background),
    "--foreground": slot(theme, "foreground", foreground),
    "--card": slot(theme, "card", mix(background, surfaceMix, surfacePercent)),
    "--card-foreground": slot(theme, "cardForeground", foreground),
    "--popover": slot(theme, "popover", mix(background, surfaceMix, surfacePercent)),
    "--popover-foreground": slot(theme, "popoverForeground", foreground),
    "--primary": slot(theme, "primary", accent),
    "--primary-foreground": slot(theme, "primaryForeground", dark ? "#0a0a0a" : "#ffffff"),
    "--secondary": slot(theme, "secondary", alpha(neutral, quietOpacity)),
    "--secondary-foreground": slot(theme, "secondaryForeground", foreground),
    "--muted": slot(theme, "muted", alpha(neutral, quietOpacity)),
    "--muted-foreground": slot(theme, "mutedForeground", mix(neutral, foreground, 76)),
    "--accent": slot(theme, "accent", alpha(accent, dark ? 18 : 10)),
    "--accent-foreground": slot(theme, "accentForeground", foreground),
    "--border": slot(theme, "border", alpha(neutral, dark ? 20 : 16)),
    "--input": slot(theme, "input", alpha(neutral, dark ? 24 : 20)),
    "--ring": slot(theme, "ring", accent),
    "--destructive": slot(theme, "destructive", dark ? "#f87171" : "#ef4444"),
    "--destructive-foreground": slot(theme, "destructiveForeground", dark ? "#fca5a5" : "#b91c1c"),
    "--info": slot(theme, "info", "#3b82f6"),
    "--info-foreground": slot(theme, "infoForeground", dark ? "#60a5fa" : "#1d4ed8"),
    "--success": slot(theme, "success", "#10b981"),
    "--success-foreground": slot(theme, "successForeground", dark ? "#34d399" : "#047857"),
    "--warning": slot(theme, "warning", "#f59e0b"),
    "--warning-foreground": slot(theme, "warningForeground", dark ? "#fbbf24" : "#b45309"),
  };
}
