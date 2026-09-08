import { Hct, argbFromHex, hexFromArgb } from "@material/material-color-utilities";

import type { MobileThemeAppearance, MobileThemeVariables } from "./mobileTheme";
import type { MaterialYouPalette } from "./materialYouPalette";

function withAlpha(color: string, alpha: number): string {
  const match = /^#([\da-f]{6})(?:[\da-f]{2})?$/iu.exec(color);
  if (!match?.[1]) return color;
  const alphaByte = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `#${match[1]}${alphaByte}`;
}

function materialTone(color: string, tone: number): string {
  const match = /^#([\da-f]{6})(?:[\da-f]{2})?$/iu.exec(color);
  if (!match?.[1]) return color;

  const source = Hct.fromInt(argbFromHex(match[1]));
  return `${hexFromArgb(Hct.from(source.hue, source.chroma, tone).toInt()).toUpperCase()}FF`;
}

export function materialYouPaletteToMobileThemeVariables(
  palette: MaterialYouPalette,
  appearance: MobileThemeAppearance,
  base: MobileThemeVariables,
): MobileThemeVariables {
  const dark = appearance === "dark";
  const userBubble = dark ? materialTone(palette.inversePrimary, 30) : palette.primary;
  const userBubbleForeground = dark ? materialTone(palette.inversePrimary, 90) : palette.onPrimary;

  return {
    ...base,
    "--color-screen": palette.surface,
    "--color-sheet": withAlpha(palette.surfaceContainerLow, 0.98),
    "--color-sheet-solid": palette.surfaceContainerLow,
    "--color-card": palette.surfaceContainer,
    "--color-card-alt": palette.surfaceContainerHigh,
    "--color-card-translucent": withAlpha(palette.surfaceContainer, 0.8),
    "--color-foreground": palette.onSurface,
    "--color-foreground-secondary": palette.onSurfaceVariant,
    "--color-foreground-muted": palette.onSurfaceVariant,
    "--color-foreground-tertiary": withAlpha(palette.onSurfaceVariant, 0.58),
    "--color-border": withAlpha(palette.outlineVariant, dark ? 0.5 : 0.65),
    "--color-border-subtle": withAlpha(palette.outlineVariant, dark ? 0.34 : 0.46),
    "--color-separator": withAlpha(palette.outlineVariant, dark ? 0.24 : 0.34),
    "--color-subtle": withAlpha(palette.onSurface, 0.05),
    "--color-subtle-strong": withAlpha(palette.onSurface, 0.1),
    "--color-inline-skill-background": withAlpha(palette.tertiaryContainer, 0.52),
    "--color-inline-skill-border": withAlpha(palette.tertiary, 0.38),
    "--color-inline-skill-foreground": palette.onTertiaryContainer,
    "--color-primary": palette.primary,
    "--color-primary-foreground": palette.onPrimary,
    "--color-primary-shadow": withAlpha(palette.scrim, dark ? 0.22 : 0.18),
    "--color-secondary": palette.secondaryContainer,
    "--color-secondary-foreground": palette.onSecondaryContainer,
    "--color-secondary-border": withAlpha(palette.outlineVariant, dark ? 0.42 : 0.56),
    "--color-switch-active-track": palette.primary,
    "--color-switch-active-thumb": palette.onPrimary,
    "--color-switch-inactive-track": palette.surfaceContainerHighest,
    "--color-switch-inactive-thumb": palette.outline,
    "--color-danger": palette.errorContainer,
    "--color-danger-border": withAlpha(palette.onErrorContainer, dark ? 0.42 : 0.5),
    "--color-danger-foreground": palette.onErrorContainer,
    "--color-input": palette.surfaceContainerLowest,
    "--color-input-border": withAlpha(palette.outline, dark ? 0.42 : 0.5),
    "--color-sidebar-search": palette.surfaceContainerLowest,
    "--color-placeholder": withAlpha(palette.onSurface, 0.62),
    "--color-icon": palette.onSurface,
    "--color-icon-muted": palette.onSurfaceVariant,
    "--color-icon-subtle": withAlpha(palette.onSurfaceVariant, 0.68),
    "--color-header": palette.surfaceContainerHigh,
    "--color-header-border": withAlpha(palette.outlineVariant, dark ? 0.36 : 0.48),
    "--color-glass-surface": withAlpha(palette.surfaceContainerHigh, dark ? 0.78 : 0.72),
    "--color-glass-tint": withAlpha(palette.primaryContainer, dark ? 0.24 : 0.18),
    "--color-status-bar": palette.surfaceContainerLow,
    "--color-md-body": materialTone(palette.onSurfaceVariant, dark ? 90 : 10),
    "--color-md-strong": materialTone(palette.onSurfaceVariant, dark ? 90 : 10),
    "--color-md-link": palette.primary,
    "--color-md-blockquote-border": withAlpha(palette.primary, dark ? 0.34 : 0.26),
    "--color-md-blockquote-bg": withAlpha(palette.primaryContainer, dark ? 0.14 : 0.2),
    "--color-md-code-bg": withAlpha(palette.onSurface, dark ? 0.08 : 0.06),
    "--color-md-code-text": palette.onSurface,
    "--color-md-user-code-bg": withAlpha(userBubbleForeground, dark ? 0.18 : 0.22),
    "--color-md-user-code-text": userBubbleForeground,
    "--color-md-user-fence-bg": withAlpha(userBubbleForeground, dark ? 0.14 : 0.18),
    "--color-md-user-fence-text": userBubbleForeground,
    "--color-md-hr": withAlpha(palette.outlineVariant, dark ? 0.48 : 0.6),
    "--color-user-bubble": userBubble,
    "--color-user-bubble-foreground": userBubbleForeground,
    "--color-user-bubble-foreground-muted": withAlpha(userBubbleForeground, 0.78),
    "--color-user-bubble-skill-foreground": userBubbleForeground,
    "--color-backdrop": withAlpha(palette.scrim, dark ? 0.48 : 0.22),
    "--color-drawer": palette.surface,
    "--color-drawer-shadow": withAlpha(palette.scrim, dark ? 0.32 : 0.12),
    "--color-dot-separator": withAlpha(palette.onSurface, 0.2),
    "--color-wordmark": palette.onSurface,
    "--color-chevron": withAlpha(palette.onSurface, 0.2),
  };
}
