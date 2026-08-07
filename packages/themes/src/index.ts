/**
 * Pure theme definitions and palette generation shared by web and native
 * clients. This module intentionally has no DOM, storage, or app imports.
 */

export const T3_CHAT_THEME_ID = "t3-chat" as const;
export const T3_CHAT_THEME_LABEL = "T3 Chat";
export const GROVE_THEME_ID = "grove" as const;
export const GROVE_THEME_LABEL = "Grove";
export const OCEAN_THEME_ID = "ocean" as const;
export const OCEAN_THEME_LABEL = "Ocean";
export const EMBER_THEME_ID = "ember" as const;
export const EMBER_THEME_LABEL = "Ember";
export const IRIS_THEME_ID = "iris" as const;
export const IRIS_THEME_LABEL = "Iris";
export const THEME_FILE_VERSION = 1 as const;

export const THEME_COLOR_ROLES = [
  "canvas",
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export type ThemeAppearance = "light" | "dark";
export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;
export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>;
export type ThemeVariants = Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>;
export type ThemeVariantOverrides = Readonly<Partial<Record<ThemeAppearance, ThemeColorOverrides>>>;
export type ThemePreferenceMode = ThemeAppearance | "system";
export type ThemeDefinition = Readonly<{
  id: string;
  label: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  variants?: ThemeVariants;
  managed?: boolean;
}>;
export type ThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColorOverrides;
  variants?: ThemeVariantOverrides;
  managed?: boolean;
}>;

export const RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  "system",
  "light",
  "dark",
  T3_CHAT_THEME_ID,
  GROVE_THEME_ID,
  OCEAN_THEME_ID,
  EMBER_THEME_ID,
  IRIS_THEME_ID,
  "t3-chat-dark",
  "t3-grove",
  "t3-ocean",
  "t3-ember",
  "t3-iris",
  "catppuccin",
  "tokyo-night",
  "dracula",
  "nord",
  "gruvbox",
  "one-dark",
  "solarized",
  "kanagawa",
  "rose-pine",
  "vesper",
  "terminal",
  "github",
  "monokai",
  "poimandres",
  "synthwave",
  "monochrome",
  "lavender",
  "sunset",
  "aurora",
  "retro",
  "termius",
  "manhattan",
  "cyberpunk",
  "winter",
]);

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);

export function isThemeColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
  );
}

type ThemeRgbColor = { r: number; g: number; b: number };
type ThemeHslColor = { h: number; s: number; l: number };
type ThemeOklch = { L: number; C: number; h: number };

const THEME_LIGHT_FOREGROUND: ThemeRgbColor = { r: 255, g: 250, b: 255 };
const THEME_DARK_FOREGROUND: ThemeRgbColor = { r: 36, g: 21, b: 35 };
const THEME_WHITE_FOREGROUND: ThemeRgbColor = { r: 255, g: 255, b: 255 };
const THEME_BLACK_FOREGROUND: ThemeRgbColor = { r: 0, g: 0, b: 0 };

function parseThemeRgbColor(value: string, fallback: ThemeRgbColor): ThemeRgbColor {
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!match) return fallback;
  const raw = match[1];
  if (!raw) return fallback;
  const hex =
    raw.length <= 4
      ? raw
          .slice(0, 3)
          .split("")
          .map((part) => part.repeat(2))
          .join("")
      : raw.slice(0, 6);
  if (hex.length !== 6) return fallback;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function themeRgbToHexColor(color: ThemeRgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function themeRgbToHsl(color: ThemeRgbColor): ThemeHslColor {
  const red = color.r / 255;
  const green = color.g / 255;
  const blue = color.b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l: lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: saturation, l: lightness };
}

function themeHslToRgb(color: ThemeHslColor): ThemeRgbColor {
  const hue = ((color.h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * color.l - 1)) * color.s;
  const hueSector = hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSector % 2) - 1));
  const match = color.l - chroma / 2;
  const [red, green, blue] =
    hueSector < 1
      ? [chroma, secondary, 0]
      : hueSector < 2
        ? [secondary, chroma, 0]
        : hueSector < 3
          ? [0, chroma, secondary]
          : hueSector < 4
            ? [0, secondary, chroma]
            : hueSector < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 };
}

function mixThemeRgbColors(
  base: ThemeRgbColor,
  overlay: ThemeRgbColor,
  amount: number,
): ThemeRgbColor {
  return {
    r: base.r + (overlay.r - base.r) * amount,
    g: base.g + (overlay.g - base.g) * amount,
    b: base.b + (overlay.b - base.b) * amount,
  };
}

function themeRelativeLuminance(color: ThemeRgbColor): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

function themeContrastRatio(first: ThemeRgbColor, second: ThemeRgbColor): number {
  const firstLuminance = themeRelativeLuminance(first);
  const secondLuminance = themeRelativeLuminance(second);
  return (
    Math.max(firstLuminance, secondLuminance) + 0.05
  ) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function readableThemeForeground(background: ThemeRgbColor): ThemeRgbColor {
  const lightContrast = themeContrastRatio(background, THEME_LIGHT_FOREGROUND);
  const darkContrast = themeContrastRatio(background, THEME_DARK_FOREGROUND);
  if (Math.max(lightContrast, darkContrast) >= 4.5) {
    return lightContrast >= darkContrast ? THEME_LIGHT_FOREGROUND : THEME_DARK_FOREGROUND;
  }
  return themeContrastRatio(background, THEME_WHITE_FOREGROUND) >=
    themeContrastRatio(background, THEME_BLACK_FOREGROUND)
    ? THEME_WHITE_FOREGROUND
    : THEME_BLACK_FOREGROUND;
}

function readableThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
  amount: number,
  minimumRatio: number,
): ThemeRgbColor {
  const softened = mixThemeRgbColors(foreground, background, amount);
  if (themeContrastRatio(softened, background) >= minimumRatio) return softened;
  let readable = foreground;
  let lowerAmount = 0;
  let upperAmount = amount;
  for (let index = 0; index < 12; index += 1) {
    const candidateAmount = (lowerAmount + upperAmount) / 2;
    const candidate = mixThemeRgbColors(foreground, background, candidateAmount);
    if (themeContrastRatio(candidate, background) >= minimumRatio) {
      readable = candidate;
      lowerAmount = candidateAmount;
    } else {
      upperAmount = candidateAmount;
    }
  }
  return readable;
}

const STANDARD_LIGHT_MUTED_CONTRAST = 4.705;
const STANDARD_DARK_MUTED_CONTRAST = 5.082;

function standardMutedThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
): ThemeRgbColor {
  const target =
    themeRelativeLuminance(background) < 0.179
      ? STANDARD_DARK_MUTED_CONTRAST
      : STANDARD_LIGHT_MUTED_CONTRAST;
  return readableThemeText(background, foreground, 1, target);
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

function themeRgbToOklch(color: ThemeRgbColor): ThemeOklch {
  const r = srgbChannelToLinear(color.r);
  const g = srgbChannelToLinear(color.g);
  const b = srgbChannelToLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

function oklchToRgbUnclamped({ L, C, h }: ThemeOklch): ThemeRgbColor {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const bb = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function themeOklchToRgb(color: ThemeOklch): ThemeRgbColor {
  let { C } = color;
  for (let step = 0; step < 12; step += 1) {
    const linear = oklchToRgbUnclamped({ ...color, C });
    if ([linear.r, linear.g, linear.b].every((channel) => channel >= -0.0001 && channel <= 1.0001)) {
      return {
        r: linearChannelToSrgb(linear.r),
        g: linearChannelToSrgb(linear.g),
        b: linearChannelToSrgb(linear.b),
      };
    }
    C *= 0.82;
  }
  const linear = oklchToRgbUnclamped({ ...color, C: 0 });
  return {
    r: linearChannelToSrgb(linear.r),
    g: linearChannelToSrgb(linear.g),
    b: linearChannelToSrgb(linear.b),
  };
}

function solveOklchLightness(
  base: ThemeOklch,
  against: ThemeRgbColor,
  minContrast: number,
  direction: "lighter" | "darker",
): ThemeOklch {
  let low = direction === "lighter" ? base.L : 0;
  let high = direction === "lighter" ? 1 : base.L;
  let candidate = { ...base };
  if (themeContrastRatio(themeOklchToRgb(candidate), against) >= minContrast) return candidate;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    candidate = { ...base, L: mid };
    if (themeContrastRatio(themeOklchToRgb(candidate), against) >= minContrast) {
      if (direction === "lighter") high = mid;
      else low = mid;
    } else if (direction === "lighter") {
      low = mid;
    } else {
      high = mid;
    }
  }
  return { ...base, L: direction === "lighter" ? high : low };
}

const STANDARD_STATUS_COLORS = {
  light: { error: "#fb2c36", errorForeground: "#c10007", warning: "#fe9a00", warningForeground: "#bb4d00" },
  dark: { error: "#fb414a", errorForeground: "#ff6467", warning: "#fe9a00", warningForeground: "#ffb900" },
} as const;

function standardStatusColors(canvas: ThemeRgbColor) {
  const appearance: ThemeAppearance = themeRelativeLuminance(canvas) < 0.179 ? "dark" : "light";
  const standard = STANDARD_STATUS_COLORS[appearance];
  const surfaceMix = appearance === "dark" ? 0.16 : 0.08;
  const surfaceOf = (value: string) =>
    mixThemeRgbColors(canvas, parseThemeRgbColor(value, canvas), surfaceMix);
  const readableOn = (foreground: string, surface: ThemeRgbColor) =>
    themeRgbToHexColor(
      themeOklchToRgb(
        solveOklchLightness(
          themeRgbToOklch(parseThemeRgbColor(foreground, canvas)),
          surface,
          4.6,
          appearance === "dark" ? "lighter" : "darker",
        ),
      ),
    );
  const errorSurface = surfaceOf(standard.error);
  const warningSurface = surfaceOf(standard.warning);
  return {
    ...standard,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: themeRgbToHexColor(errorSurface),
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: themeRgbToHexColor(warningSurface),
  };
}

function managedThemeBackground(value: string, appearance: ThemeAppearance): ThemeRgbColor {
  const selected = parseThemeRgbColor(
    value,
    appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  );
  const hsl = themeRgbToHsl(selected);
  return themeHslToRgb({
    h: hsl.h,
    s: Math.min(hsl.s, appearance === "dark" ? 0.3 : 0.2),
    l:
      appearance === "dark"
        ? Math.min(0.13, Math.max(0.07, hsl.l))
        : Math.min(0.985, Math.max(0.94, hsl.l)),
  });
}

function managedThemeAccent(
  value: string,
  appearance: ThemeAppearance,
  background: ThemeRgbColor,
): ThemeRgbColor {
  const selected = parseThemeRgbColor(value, { r: 168, g: 67, b: 112 });
  const hsl = themeRgbToHsl(selected);
  const preferredLightness =
    appearance === "dark"
      ? Math.min(0.72, Math.max(0.42, hsl.l))
      : Math.min(0.58, Math.max(0.35, hsl.l));
  const lightnessRange: readonly [number, number] =
    appearance === "dark" ? [0.42, 0.82] : [0.22, 0.58];
  const saturation = Math.min(hsl.s, 0.82);
  const candidates = Array.from({ length: 61 }, (_, index) => {
    const lightness = lightnessRange[0] + ((lightnessRange[1] - lightnessRange[0]) * index) / 60;
    const color = themeHslToRgb({ h: hsl.h, s: saturation, l: lightness });
    return { color, lightness, contrast: themeContrastRatio(color, background) };
  });
  const readableCandidates = candidates.filter((candidate) => candidate.contrast >= 4.7);
  const pool = readableCandidates.length > 0 ? readableCandidates : candidates;
  return pool.reduce((best, candidate) => {
    const distance = Math.abs(candidate.lightness - preferredLightness);
    const bestDistance = Math.abs(best.lightness - preferredLightness);
    return distance < bestDistance ||
      (distance === bestDistance && candidate.contrast > best.contrast)
      ? candidate
      : best;
  }).color;
}

export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? T3_CHAT_THEME.variants!.dark! : T3_CHAT_THEME.colors;
}

export function getStandardThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS;
}

export function createManagedThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
  options?: { exactSeeds?: boolean },
): ThemeColors {
  const defaults = getDefaultThemeColors(appearance);
  const canvas = options?.exactSeeds
    ? parseThemeRgbColor(
        backgroundValue,
        appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
      )
    : managedThemeBackground(backgroundValue, appearance);
  const accent = options?.exactSeeds
    ? parseThemeRgbColor(accentValue, { r: 168, g: 67, b: 112 })
    : managedThemeAccent(accentValue, appearance, canvas);
  const text = readableThemeForeground(canvas);
  const textMuted = standardMutedThemeText(canvas, text);
  const chrome = canvas;
  const sidebar = mixThemeRgbColors(canvas, accent, 0.08);
  const surfaceRaised = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.12 : 0.035);
  const surfaceOverlay = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.18 : 0.06);
  const secondary = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.2 : 0.08);
  const muted = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.13 : 0.06);
  const accentSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.3 : 0.14);
  const messageSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.36 : 0.18);
  const toolbarControl = mixThemeRgbColors(chrome, accent, appearance === "dark" ? 0.2 : 0.08);
  const toolbarBorder = mixThemeRgbColors(chrome, accent, appearance === "dark" ? 0.35 : 0.14);
  const accentForeground = readableThemeForeground(accent);
  const codeBackground = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.06 : 0.025);
  const messageActionHover = mixThemeRgbColors(
    accent,
    accentForeground === THEME_LIGHT_FOREGROUND || accentForeground === THEME_WHITE_FOREGROUND
      ? THEME_BLACK_FOREGROUND
      : THEME_WHITE_FOREGROUND,
    0.12,
  );
  const updateSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.32 : 0.16);
  const updateForeground = mixThemeRgbColors(
    accent,
    appearance === "dark" ? THEME_WHITE_FOREGROUND : THEME_BLACK_FOREGROUND,
    0.35,
  );
  return {
    ...defaults,
    ...standardStatusColors(canvas),
    update: themeRgbToHexColor(accent),
    updateForeground: themeRgbToHexColor(updateForeground),
    updateSurface: themeRgbToHexColor(updateSurface),
    canvas: themeRgbToHexColor(canvas),
    chrome: themeRgbToHexColor(chrome),
    toolbar: themeRgbToHexColor(chrome),
    toolbarForeground: themeRgbToHexColor(text),
    toolbarBorder: themeRgbToHexColor(toolbarBorder),
    toolbarControl: themeRgbToHexColor(toolbarControl),
    toolbarControlForeground: themeRgbToHexColor(text),
    toolbarControlHover: themeRgbToHexColor(accentSurface),
    surface: themeRgbToHexColor(canvas),
    surfaceRaised: themeRgbToHexColor(surfaceRaised),
    surfaceOverlay: themeRgbToHexColor(surfaceOverlay),
    text: themeRgbToHexColor(text),
    textMuted: themeRgbToHexColor(textMuted),
    border: themeRgbToHexColor(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.22 : 0.1),
        text,
        0.1,
      ),
    ),
    input: themeRgbToHexColor(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.3 : 0.14),
        text,
        appearance === "dark" ? 0.14 : 0.13,
      ),
    ),
    focus: themeRgbToHexColor(accent),
    accent: themeRgbToHexColor(accent),
    accentForeground: themeRgbToHexColor(accentForeground),
    secondary: themeRgbToHexColor(secondary),
    secondaryForeground: themeRgbToHexColor(readableThemeForeground(secondary)),
    muted: themeRgbToHexColor(muted),
    mutedForeground: themeRgbToHexColor(textMuted),
    placeholder: themeRgbToHexColor(textMuted),
    secondaryLabel: themeRgbToHexColor(textMuted),
    iconMuted: themeRgbToHexColor(textMuted),
    accentSurface: themeRgbToHexColor(accentSurface),
    accentSurfaceForeground: themeRgbToHexColor(readableThemeForeground(accentSurface)),
    messageSurface: themeRgbToHexColor(messageSurface),
    messageForeground: themeRgbToHexColor(readableThemeForeground(messageSurface)),
    messageAction: themeRgbToHexColor(accent),
    messageActionForeground: themeRgbToHexColor(accentForeground),
    messageActionHover: themeRgbToHexColor(messageActionHover),
    codeBackground: themeRgbToHexColor(codeBackground),
    codeForeground: themeRgbToHexColor(readableThemeForeground(codeBackground)),
    sidebar: themeRgbToHexColor(sidebar),
    sidebarForeground: themeRgbToHexColor(readableThemeForeground(sidebar)),
    sidebarMutedForeground: themeRgbToHexColor(standardMutedThemeText(sidebar, text)),
    sidebarControlSurface: themeRgbToHexColor(
      mixThemeRgbColors(sidebar, text, appearance === "dark" ? 0.16 : 0.08),
    ),
    sidebarRowHover: themeRgbToHexColor(mixThemeRgbColors(sidebar, accent, 0.12)),
    sidebarRowActive: themeRgbToHexColor(mixThemeRgbColors(sidebar, accent, 0.2)),
    sidebarRowSelected: themeRgbToHexColor(mixThemeRgbColors(sidebar, accent, 0.24)),
    sidebarBorder: themeRgbToHexColor(
      mixThemeRgbColors(sidebar, text, appearance === "dark" ? 0.35 : 0.12),
    ),
    terminalBackground: themeRgbToHexColor(canvas),
    terminalForeground: themeRgbToHexColor(readableThemeForeground(canvas)),
    terminalCursor: themeRgbToHexColor(accent),
    terminalSelection: themeRgbToHexColor(
      mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.35 : 0.18),
    ),
    terminalScrollbar: themeRgbToHexColor(
      mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.42 : 0.22),
    ),
    terminalScrollbarHover: themeRgbToHexColor(
      mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.55 : 0.32),
    ),
  };
}

export function createVividThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
): ThemeColors {
  const defaults = getDefaultThemeColors(appearance);
  const canvasRgb = parseThemeRgbColor(
    backgroundValue,
    appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  );
  const accentRgb = parseThemeRgbColor(accentValue, { r: 168, g: 67, b: 112 });
  const canvas = themeRgbToOklch(canvasRgb);
  const accent = themeRgbToOklch(accentRgb);
  const dark = themeRelativeLuminance(canvasRgb) < 0.179;
  const hue = accent.C < 0.02 ? canvas.h : accent.h;
  const tintC = Math.min(0.045, Math.max(0.008, accent.C * 0.22));
  const step = dark ? 1 : -1;
  const surfaceAt = (deltaL: number, chroma = tintC): ThemeOklch => ({
    L: Math.min(0.98, Math.max(0.05, canvas.L + step * deltaL)),
    C: chroma,
    h: hue,
  });
  const hex = (color: ThemeOklch) => themeRgbToHexColor(themeOklchToRgb(color));
  const textBase: ThemeOklch = {
    L: dark ? 0.95 : 0.2,
    C: Math.min(0.035, accent.C * 0.25),
    h: hue,
  };
  const text = solveOklchLightness(textBase, canvasRgb, 7, dark ? "lighter" : "darker");
  const textRgb = themeOklchToRgb(text);
  const textMutedRgb = standardMutedThemeText(canvasRgb, textRgb);
  const action: ThemeOklch = {
    L: Math.min(0.85, Math.max(0.35, accent.L + (dark ? 0.06 : -0.02))),
    C: Math.max(accent.C * 0.9, 0.06),
    h: (hue + 50) % 360,
  };
  const actionRgb = themeOklchToRgb(action);
  const actionForeground = readableThemeForeground(actionRgb);
  const accentForeground = readableThemeForeground(accentRgb);
  const sidebar = surfaceAt(0.045, tintC * 1.4);
  const sidebarRgb = themeOklchToRgb(sidebar);
  const surface = surfaceAt(0.015);
  const surfaceRaised = surfaceAt(0.05);
  const surfaceOverlay = surfaceAt(0.075);
  const border = surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, accent.C * 0.35));
  const input = surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, accent.C * 0.4));
  const secondary = surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, accent.C * 0.5));
  const secondaryRgb = themeOklchToRgb(secondary);
  const muted = surfaceAt(dark ? 0.06 : 0.04, Math.min(0.06, accent.C * 0.35));
  const accentSurface = surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, accent.C * 0.55));
  const accentSurfaceRgb = themeOklchToRgb(accentSurface);
  const messageSurface = surfaceAt(dark ? 0.16 : 0.1, Math.min(0.13, accent.C * 0.6));
  const messageSurfaceRgb = themeOklchToRgb(messageSurface);
  const codeBackground = surfaceAt(0.035, tintC * 0.8);
  const updateSurface = surfaceAt(dark ? 0.14 : 0.09, Math.min(0.12, accent.C * 0.55));
  const foregroundOn = (surfaceRgb: ThemeRgbColor): string =>
    themeRgbToHexColor(
      themeOklchToRgb(solveOklchLightness(textBase, surfaceRgb, 4.6, dark ? "lighter" : "darker")),
    );
  const actionHover: ThemeOklch = { ...action, L: action.L + (dark ? 0.06 : -0.06) };
  return {
    ...defaults,
    ...standardStatusColors(canvasRgb),
    canvas: themeRgbToHexColor(canvasRgb),
    chrome: themeRgbToHexColor(canvasRgb),
    toolbar: themeRgbToHexColor(canvasRgb),
    toolbarForeground: themeRgbToHexColor(textRgb),
    toolbarBorder: hex(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.08, accent.C * 0.4))),
    toolbarControl: hex(surfaceAt(dark ? 0.09 : 0.05, tintC * 1.3)),
    toolbarControlForeground: themeRgbToHexColor(textRgb),
    toolbarControlHover: hex(surfaceAt(dark ? 0.14 : 0.09, tintC * 1.6)),
    surface: hex(surface),
    surfaceRaised: hex(surfaceRaised),
    surfaceOverlay: hex(surfaceOverlay),
    text: themeRgbToHexColor(textRgb),
    textMuted: themeRgbToHexColor(textMutedRgb),
    border: hex(border),
    input: hex(input),
    focus: themeRgbToHexColor(accentRgb),
    accent: themeRgbToHexColor(accentRgb),
    accentForeground: themeRgbToHexColor(accentForeground),
    secondary: hex(secondary),
    secondaryForeground: foregroundOn(secondaryRgb),
    muted: hex(muted),
    mutedForeground: themeRgbToHexColor(textMutedRgb),
    placeholder: themeRgbToHexColor(textMutedRgb),
    secondaryLabel: themeRgbToHexColor(textMutedRgb),
    iconMuted: themeRgbToHexColor(textMutedRgb),
    update: themeRgbToHexColor(accentRgb),
    updateForeground: foregroundOn(themeOklchToRgb(updateSurface)),
    updateSurface: hex(updateSurface),
    accentSurface: hex(accentSurface),
    accentSurfaceForeground: foregroundOn(accentSurfaceRgb),
    messageSurface: hex(messageSurface),
    messageForeground: foregroundOn(messageSurfaceRgb),
    messageAction: themeRgbToHexColor(actionRgb),
    messageActionForeground: themeRgbToHexColor(actionForeground),
    messageActionHover: hex(actionHover),
    codeBackground: hex(codeBackground),
    codeForeground: themeRgbToHexColor(textRgb),
    sidebar: hex(sidebar),
    sidebarForeground: foregroundOn(sidebarRgb),
    sidebarMutedForeground: themeRgbToHexColor(standardMutedThemeText(sidebarRgb, textRgb)),
    sidebarControlSurface: hex(surfaceAt(dark ? 0.1 : 0.07, tintC * 1.5)),
    sidebarRowHover: hex(surfaceAt(dark ? 0.08 : 0.06, Math.min(0.08, accent.C * 0.45))),
    sidebarRowActive: hex(surfaceAt(dark ? 0.12 : 0.09, Math.min(0.1, accent.C * 0.55))),
    sidebarRowSelected: hex(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, accent.C * 0.6))),
    sidebarBorder: hex(surfaceAt(dark ? 0.17 : 0.12, Math.min(0.08, accent.C * 0.4))),
    terminalBackground: themeRgbToHexColor(canvasRgb),
    terminalForeground: themeRgbToHexColor(textRgb),
    terminalCursor: themeRgbToHexColor(accentRgb),
    terminalSelection: hex(surfaceAt(dark ? 0.18 : 0.12, Math.min(0.12, accent.C * 0.55))),
    terminalScrollbar: hex(surfaceAt(dark ? 0.22 : 0.16, tintC)),
    terminalScrollbarHover: hex(surfaceAt(dark ? 0.3 : 0.22, tintC)),
  };
}

export {
  BUILT_IN_THEME_DEFINITIONS,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  T3_CHAT_THEME,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
} from "./builtInThemes.ts";

import {
  BUILT_IN_THEME_DEFINITIONS,
  T3_CHAT_THEME,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
} from "./builtInThemes.ts";

export function getThemeDefinition(id: string): ThemeDefinition | null {
  return BUILT_IN_THEME_DEFINITIONS.find((theme) => theme.id === id) ?? null;
}

export function getThemeColorsForMode(
  theme: ThemeDefinition,
  mode: ThemeAppearance,
): ThemeColors | null {
  if (mode === theme.appearance) return theme.colors;
  return theme.variants?.[mode] ?? null;
}

export function getThemeModes(theme: ThemeDefinition): ReadonlyArray<ThemeAppearance> {
  return (["light", "dark"] as const).filter((mode) => getThemeColorsForMode(theme, mode) !== null);
}
