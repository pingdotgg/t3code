import {
  BUILT_IN_THEMES,
  getThemeColorsForAppearance,
  MOBILE_DEFAULT_THEME_ID,
  MOBILE_THEME_IDS as SHARED_MOBILE_THEME_IDS,
  type MobileThemeId as SharedMobileThemeId,
  type ThemeAppearance,
  type ThemeColors,
} from "@t3tools/shared/themePalettes";
import {
  STANDARD_THEME_PREVIEW_COLORS,
  type ThemePreviewColors,
} from "@t3tools/shared/themePreview";
import { DEFAULT_MOBILE_THEME_VARIABLES } from "./mobileDefaultTheme";

export const DEFAULT_MOBILE_THEME_ID = MOBILE_DEFAULT_THEME_ID;
export const MOBILE_THEME_IDS = SHARED_MOBILE_THEME_IDS;
export type MobileThemeId = SharedMobileThemeId;
export type MobileThemeAppearance = ThemeAppearance;
export type MobileThemeMode = MobileThemeAppearance | "system";
export type MobileThemeIds = Readonly<Record<MobileThemeAppearance, MobileThemeId>>;

export const MOBILE_THEME_OPTIONS: ReadonlyArray<{
  readonly id: MobileThemeId;
  readonly label: string;
}> = [
  { id: DEFAULT_MOBILE_THEME_ID, label: "T3 Code" },
  ...BUILT_IN_THEMES.map((theme) => ({ id: theme.id as MobileThemeId, label: theme.label })),
];

type MobileThemeVariable = `--color-${string}`;
export type MobileThemeVariables = Readonly<Record<MobileThemeVariable, string>>;

export function normalizeMobileThemeId(value: unknown): MobileThemeId {
  return typeof value === "string" && (MOBILE_THEME_IDS as readonly string[]).includes(value)
    ? (value as MobileThemeId)
    : DEFAULT_MOBILE_THEME_ID;
}

export function normalizeMobileThemeMode(value: unknown): MobileThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveMobileThemeIds(preferences: {
  readonly themeId?: unknown;
  readonly lightThemeId?: unknown;
  readonly darkThemeId?: unknown;
}): MobileThemeIds {
  const legacyThemeId = normalizeMobileThemeId(preferences.themeId);
  return {
    light:
      preferences.lightThemeId === undefined
        ? legacyThemeId
        : normalizeMobileThemeId(preferences.lightThemeId),
    dark:
      preferences.darkThemeId === undefined
        ? legacyThemeId
        : normalizeMobileThemeId(preferences.darkThemeId),
  };
}

export function createMobileThemeSelectionPatch(
  themeIds: MobileThemeIds,
  activeAppearance: MobileThemeAppearance,
  selectedAppearance: MobileThemeAppearance,
  value: MobileThemeId,
) {
  const nextThemeIds: MobileThemeIds = {
    light: selectedAppearance === "light" ? value : themeIds.light,
    dark: selectedAppearance === "dark" ? value : themeIds.dark,
  };
  return {
    lightThemeId: nextThemeIds.light,
    darkThemeId: nextThemeIds.dark,
    // Keep older OTA bundles on the theme for the appearance currently in use.
    themeId: nextThemeIds[activeAppearance],
  };
}

export function createMobileThemePairPatch(value: MobileThemeId) {
  return {
    lightThemeId: value,
    darkThemeId: value,
    themeId: value,
  };
}

const OKLCH_PATTERN = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/;

function linearToSrgb(value: number): number {
  const converted = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, converted)) * 255);
}

/** React Native does not accept OKLCH ColorValues, so palettes cross the app boundary as sRGB. */
export function themeColorToNativeColor(value: string): string {
  const match = OKLCH_PATTERN.exec(value);
  if (!match) return value;

  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = (Number(match[3]) * Math.PI) / 180;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const red = linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);

  return alpha < 1
    ? `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(4))})`
    : `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function nativeColors(colors: ThemeColors): ThemeColors {
  return Object.fromEntries(
    Object.entries(colors).map(([role, color]) => [role, themeColorToNativeColor(color)]),
  ) as ThemeColors;
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.startsWith("#") ? color.slice(1) : "";
  if (hex.length !== 6) return color;
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function rgbChannels(color: string): readonly [number, number, number] | null {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  return match
    ? [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)]
    : null;
}

function relativeLuminance(channels: readonly [number, number, number]): number {
  const [red, green, blue] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(
  first: readonly [number, number, number],
  second: readonly [number, number, number],
): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

/** Preserve the theme's action hue while making it readable as skill text on a message bubble. */
function readableMessageAccent(accent: string, surface: string): string {
  const accentChannels = rgbChannels(accent);
  const surfaceChannels = rgbChannels(surface);
  if (
    !accentChannels ||
    !surfaceChannels ||
    contrastRatio(accentChannels, surfaceChannels) >= 4.5
  ) {
    return accent;
  }

  const black = [0, 0, 0] as const;
  const white = [255, 255, 255] as const;
  const target =
    contrastRatio(black, surfaceChannels) >= contrastRatio(white, surfaceChannels) ? black : white;
  let readable: readonly [number, number, number] = target;
  let lowerAmount = 0;
  let upperAmount = 1;
  for (let index = 0; index < 12; index += 1) {
    const amount = (lowerAmount + upperAmount) / 2;
    const candidate: readonly [number, number, number] = [
      Math.round(accentChannels[0] + (target[0] - accentChannels[0]) * amount),
      Math.round(accentChannels[1] + (target[1] - accentChannels[1]) * amount),
      Math.round(accentChannels[2] + (target[2] - accentChannels[2]) * amount),
    ];
    if (contrastRatio(candidate, surfaceChannels) >= 4.5) {
      readable = candidate;
      upperAmount = amount;
    } else {
      lowerAmount = amount;
    }
  }
  return `#${readable.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function themeColorWithAlpha(color: string, alpha: number): string {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (hex) {
    return `rgba(${Number.parseInt(hex[1], 16)}, ${Number.parseInt(hex[2], 16)}, ${Number.parseInt(hex[3], 16)}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color);
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` : color;
}

export function createMobileThemeVariables(
  colors: ThemeColors,
  appearance: MobileThemeAppearance,
): MobileThemeVariables {
  const c = nativeColors(colors);
  return {
    "--color-screen": c.canvas,
    "--color-sheet": withAlpha(c.chrome, 0.98),
    "--color-sheet-solid": c.chrome,
    "--color-card": c.surfaceRaised,
    "--color-card-alt": c.surface,
    "--color-card-translucent": withAlpha(c.surfaceRaised, 0.8),
    "--color-foreground": c.text,
    "--color-foreground-secondary": c.textMuted,
    "--color-foreground-muted": c.mutedForeground,
    "--color-foreground-tertiary": c.secondaryLabel,
    "--color-border": c.border,
    "--color-border-subtle": withAlpha(c.border, 0.7),
    "--color-separator": withAlpha(c.border, 0.55),
    "--color-subtle": c.muted,
    "--color-subtle-strong": c.secondary,
    "--color-inline-skill-background": c.accentSurface,
    "--color-inline-skill-border": withAlpha(c.accent, 0.42),
    "--color-inline-skill-foreground": c.accentSurfaceForeground,
    "--color-primary": c.accent,
    "--color-primary-foreground": c.accentForeground,
    "--color-primary-shadow": "#000000",
    "--color-secondary": c.secondary,
    "--color-secondary-foreground": c.secondaryForeground,
    "--color-secondary-border": c.border,
    "--color-switch-active-track": c.accent,
    "--color-switch-active-thumb": c.accentForeground,
    "--color-switch-inactive-track": c.secondary,
    "--color-switch-inactive-thumb": c.mutedForeground,
    "--color-danger": c.errorSurface,
    "--color-danger-border": withAlpha(c.error, 0.32),
    "--color-danger-foreground": c.errorForeground,
    "--color-input": c.surfaceRaised,
    "--color-input-border": c.input,
    "--color-sidebar-search": c.sidebarControlSurface,
    "--color-placeholder": c.placeholder,
    "--color-icon": c.text,
    "--color-icon-muted": c.iconMuted,
    "--color-icon-subtle": c.secondaryLabel,
    "--color-header": withAlpha(c.toolbar, 0.97),
    "--color-header-border": c.toolbarBorder,
    "--color-glass-surface": withAlpha(c.surfaceOverlay, 0.74),
    "--color-glass-tint": withAlpha(c.surfaceOverlay, 0.22),
    "--color-status-bar": c.canvas,
    "--color-md-body": c.text,
    "--color-md-strong": c.toolbarForeground,
    "--color-md-link": c.accent,
    "--color-md-blockquote-border": c.border,
    "--color-md-blockquote-bg": c.muted,
    "--color-md-code-bg": c.codeBackground,
    "--color-md-code-text": c.codeForeground,
    "--color-md-user-code-bg": withAlpha(c.messageForeground, 0.18),
    "--color-md-user-code-text": c.messageForeground,
    "--color-md-user-fence-bg": withAlpha("#000000", appearance === "dark" ? 0.28 : 0.16),
    "--color-md-user-fence-text": c.messageForeground,
    "--color-md-hr": c.border,
    "--color-user-bubble": c.messageSurface,
    "--color-user-bubble-foreground": c.messageForeground,
    "--color-user-bubble-foreground-muted": withAlpha(c.messageForeground, 0.78),
    "--color-user-bubble-skill-foreground": readableMessageAccent(
      c.messageAction,
      c.messageSurface,
    ),
    "--color-backdrop": withAlpha("#000000", appearance === "dark" ? 0.48 : 0.22),
    "--color-drawer": withAlpha(c.sidebar, 0.99),
    "--color-drawer-shadow": withAlpha("#000000", appearance === "dark" ? 0.32 : 0.12),
    "--color-dot-separator": withAlpha(c.textMuted, 0.35),
    "--color-wordmark": c.text,
    "--color-chevron": withAlpha(c.textMuted, 0.42),
  };
}

export function getMobileThemeVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
  overrides: Partial<MobileThemeVariables> | null = null,
): MobileThemeVariables {
  const baseVariables = (() => {
    if (themeId === DEFAULT_MOBILE_THEME_ID) return DEFAULT_MOBILE_THEME_VARIABLES[appearance];
    const theme =
      BUILT_IN_THEMES.find((candidate) => candidate.id === themeId) ?? BUILT_IN_THEMES[0];
    const colors = getThemeColorsForAppearance(theme, appearance) ?? theme.colors;
    return createMobileThemeVariables(colors, appearance);
  })();

  // The complete base record guarantees that optional overrides cannot leave a token undefined.
  return overrides ? ({ ...baseVariables, ...overrides } as MobileThemeVariables) : baseVariables;
}

export function getMobileThemePreviewColors(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): ThemePreviewColors {
  if (themeId === DEFAULT_MOBILE_THEME_ID) return STANDARD_THEME_PREVIEW_COLORS[appearance];
  const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === themeId) ?? BUILT_IN_THEMES[0];
  const colors = getThemeColorsForAppearance(theme, appearance) ?? theme.colors;
  return {
    canvas: themeColorToNativeColor(colors.canvas),
    accent: themeColorToNativeColor(colors.accent),
    messageAction: themeColorToNativeColor(colors.messageAction),
  };
}
