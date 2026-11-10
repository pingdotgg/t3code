import { pipe } from "effect/Function";
import "culori/css";
import { converter, parse } from "culori/fn";
import {
  T3_CHAT_THEME,
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
  DEPRECATED_THEME_COLOR_ROLES,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeSource,
  type ThemeDefinition,
  getThemeColorsForAppearance,
  type ThemeColorInputs,
} from "./themePalettes.ts";

export function getStandardThemeColors(appearance: ThemeAppearance): ThemeColors {
  if (appearance === "dark") {
    return (standardDarkThemeColors ??= decodeThemeColors({
      ...T3_CODE_DARK_THEME_COLORS,
      canvas: "#000000",
    }));
  }
  return (standardLightThemeColors ??= decodeThemeColors(T3_CODE_LIGHT_THEME_COLORS));
}

// Web retains translucent surfaces and true black; native uses opaque stock colors.
const STANDARD_WEB_COLORS: Record<ThemeAppearance, Partial<ThemeColors>> = {
  light: {
    canvas: "oklch(0.992 0 0)",
    chrome: "oklch(0.992 0 0)",
    toolbar: "oklch(0.992 0 0)",
    text: "oklch(0.21 0.006 285.885)",
    toolbarForeground: "oklch(0.21 0.006 285.885)",
    toolbarControlForeground: "oklch(0.21 0.006 285.885)",
    secondaryForeground: "oklch(0.274 0.006 286.033)",
    sidebarForeground: "oklch(0.21 0.006 285.885)",
    messageForeground: "oklch(0.21 0.006 285.885)",
    codeForeground: "oklch(0.21 0.006 285.885)",
    terminalForeground: "oklch(0.21 0.006 285.885)",
    surfaceRaised: "rgb(255 255 255 / 20%)",
    messageSurface: "#ebebed",
    accent: "oklch(0.488 0.217 264)",
    focus: "oklch(0.488 0.217 264)",
    messageAction: "oklch(0.488 0.217 264)",
    update: "oklch(0.488 0.217 264)",
    updateForeground: "oklch(0.488 0.217 264)",
    errorSurface: "rgb(251 44 54 / 8%)",
    warningSurface: "rgb(254 154 0 / 8%)",
    terminalBackground: "oklch(0.992 0 0)",
    terminalSelection: "rgb(37 63 99 / 20%)",
  },
  dark: {
    canvas: "#000000",
    chrome: "#000000",
    toolbar: "#000000",
    surface: "#111111",
    surfaceRaised: "#111111",
    surfaceOverlay: "#111111",
    secondary: "rgb(255 255 255 / 3%)",
    muted: "rgb(255 255 255 / 3%)",
    accentSurface: "rgb(255 255 255 / 4%)",
    toolbarControl: "#111111",
    toolbarControlHover: "rgb(255 255 255 / 4%)",
    textMuted: "#a3a3a3",
    mutedForeground: "#a3a3a3",
    placeholder: "#a3a3a3",
    secondaryLabel: "#a3a3a3",
    iconMuted: "#a3a3a3",
    messageSurface: "#1e1e1e",
    border: "rgb(255 255 255 / 8%)",
    toolbarBorder: "rgb(255 255 255 / 8%)",
    input: "rgb(255 255 255 / 11%)",
    accent: "oklch(0.571 0.21 264)",
    focus: "oklch(0.571 0.21 264)",
    messageAction: "oklch(0.571 0.21 264)",
    update: "oklch(0.571 0.21 264)",
    errorSurface: "rgb(251 65 74 / 16%)",
    warningSurface: "rgb(254 154 0 / 16%)",
    sidebarRowHover: "rgb(255 255 255 / 8%)",
    sidebarRowActive: "rgb(255 255 255 / 11%)",
    sidebarRowSelected: "rgb(255 255 255 / 7%)",
    sidebarBorder: "rgb(255 255 255 / 8%)",
    terminalBackground: "#000000",
    terminalSelection: "rgb(180 203 255 / 25%)",
  },
};

export function getStandardPaintedThemeColors(appearance: ThemeAppearance): ThemeColors {
  return { ...getStandardThemeColors(appearance), ...STANDARD_WEB_COLORS[appearance] };
}

export type ThemeRgbColor = {
  r: number;
  g: number;
  b: number;
};

type ThemeOklch = { L: number; C: number; h: number };
type ParsedThemeColor = { color: ThemeOklch; alpha: number };

let standardLightThemeColors: ThemeColors | undefined;
let standardDarkThemeColors: ThemeColors | undefined;

const THEME_LIGHT_FOREGROUND: ThemeRgbColor = { r: 255, g: 250, b: 255 };
const THEME_DARK_FOREGROUND: ThemeRgbColor = { r: 36, g: 21, b: 35 };
export const THEME_WHITE_FOREGROUND: ThemeRgbColor = { r: 255, g: 255, b: 255 };
export const THEME_BLACK_FOREGROUND: ThemeRgbColor = { r: 0, g: 0, b: 0 };

const convertToOklch = converter("oklch");

export function parseThemeColor(value: unknown): ParsedThemeColor | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const parsed = parse(input);
  if (!parsed) return null;
  const color = convertToOklch(parsed);
  const lightness = color.l ?? 0;
  const chroma = color.c ?? 0;
  const hue = color.h ?? 0;
  // Missing CSS components are zero; Culori omits none alpha, so distinguish it from absent alpha.
  const alpha = /\/\s*none\s*\)$/i.test(input) ? 0 : (color.alpha ?? 1);
  if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return null;
  return {
    color: {
      L: Math.min(1, Math.max(0, lightness)),
      C: Math.max(0, chroma),
      h: hue,
    },
    alpha: Math.min(1, Math.max(0, alpha)),
  };
}

export function formatThemeColorNumber(value: number, precision: number): string {
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value;
  return rounded.toFixed(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, "$1");
}

function formatOklchThemeColor(color: ThemeOklch, alpha = 1): string {
  const normalizedHue = color.C < 0.0000005 ? 0 : ((color.h % 360) + 360) % 360;
  const body = `${formatThemeColorNumber(color.L, 6)} ${formatThemeColorNumber(color.C, 6)} ${formatThemeColorNumber(normalizedHue, 3)}`;
  return alpha < 1 ? `oklch(${body} / ${formatThemeColorNumber(alpha, 4)})` : `oklch(${body})`;
}

export function toCanonicalThemeColor(value: unknown): string | null {
  const parsed = parseThemeColor(value);
  return parsed ? formatOklchThemeColor(parsed.color, parsed.alpha) : null;
}

export function themeColorToHex(value: string): string | null {
  const color = parseThemeColor(value);
  const parsed = color ? { rgb: themeOklchToRgb(color.color), alpha: color.alpha } : null;
  if (!parsed) return null;

  const opaque = themeRgbToHexColor(parsed.rgb);
  if (parsed.alpha >= 1) return opaque;
  const alpha = Math.round(parsed.alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${opaque}${alpha}`;
}

function parseThemeRgbColor(value: string, fallback: ThemeRgbColor): ThemeRgbColor {
  const parsed = parseThemeColor(value);
  return parsed ? themeOklchToRgb(parsed.color) : fallback;
}

export function themeRgbToHexColor(color: ThemeRgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function themeRgbToThemeColor(color: ThemeRgbColor): string {
  return formatOklchThemeColor(themeRgbToOklch(color));
}

export function decodeThemeColors(colors: ThemeColors): ThemeColors {
  return Object.fromEntries(
    THEME_COLOR_ROLES.map((role) => {
      const color = toCanonicalThemeColor(colors[role]);
      if (!color) {
        throw new Error(
          `The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`,
        );
      }
      return [role, color];
    }),
  ) as Record<ThemeColorRole, string>;
}

export function mixThemeRgbColors(
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

export function themeRelativeLuminance(color: ThemeRgbColor): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearChannelToSrgb(channel: number, round = true): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  const srgb = Math.min(1, Math.max(0, c)) * 255;
  return round ? Math.round(srgb) : srgb;
}

export function themeRgbToOklch(color: ThemeRgbColor): ThemeOklch {
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

export function oklchToRgbUnclamped({ L, C, h }: ThemeOklch): { r: number; g: number; b: number } {
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

function mapThemeOklchToSrgbGamut(color: ThemeOklch): ThemeOklch {
  const isInGamut = (C: number) => {
    const linear = oklchToRgbUnclamped({ ...color, C });
    return [linear.r, linear.g, linear.b].every(
      (channel) => channel >= -0.0001 && channel <= 1.0001,
    );
  };
  if (isInGamut(color.C)) return color;

  let low = 0;
  let high = color.C;
  const chromaResolution = 0.000001;
  const steps = Math.max(
    1,
    Math.ceil(Math.log2(Math.max(color.C, chromaResolution)) - Math.log2(chromaResolution)),
  );
  for (let step = 0; step < steps; step += 1) {
    const mid = (low + high) / 2;
    if (isInGamut(mid)) low = mid;
    else high = mid;
  }
  return { ...color, C: low };
}

export function themeOklchToRgb(color: ThemeOklch, round = true): ThemeRgbColor {
  const linear = oklchToRgbUnclamped(mapThemeOklchToSrgbGamut(color));
  return {
    r: linearChannelToSrgb(linear.r, round),
    g: linearChannelToSrgb(linear.g, round),
    b: linearChannelToSrgb(linear.b, round),
  };
}

function themeOklchToThemeColor(color: ThemeOklch): string {
  return formatOklchThemeColor(mapThemeOklchToSrgbGamut(color));
}

export function solveOklchLightness(
  base: ThemeOklch,
  against: ReadonlyArray<ThemeRgbColor>,
  minContrast: number,
  direction: "lighter" | "darker",
): ThemeOklch {
  const contrastOf = (color: ThemeOklch) =>
    Math.min(...against.map((surface) => themeContrastRatio(themeOklchToRgb(color), surface)));
  let low = direction === "lighter" ? base.L : 0;
  let high = direction === "lighter" ? 1 : base.L;
  let candidate = { ...base };
  if (contrastOf(candidate) >= minContrast) return candidate;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    candidate = { ...base, L: mid };
    if (contrastOf(candidate) >= minContrast) {
      if (direction === "lighter") high = mid;
      else low = mid;
    } else {
      if (direction === "lighter") low = mid;
      else high = mid;
    }
  }
  return { ...base, L: direction === "lighter" ? high : low };
}

/**
 * Moves only the lightness, so a color that is too dim on `surface` keeps its
 * hue instead of collapsing to black or white.
 */
export function readableThemeColorOn(color: string, surface: string, minContrast: number): string {
  const parsedColor = parseThemeColor(color);
  const parsedSurface = parseThemeColor(surface);
  if (!parsedColor || !parsedSurface) return color;
  const surfaceRgb = themeOklchToRgb(parsedSurface.color);
  if (themeContrastRatio(themeOklchToRgb(parsedColor.color), surfaceRgb) >= minContrast) {
    return color;
  }
  const direction = themeRelativeLuminance(surfaceRgb) < 0.179 ? "lighter" : "darker";
  const solved = solveOklchLightness(parsedColor.color, [surfaceRgb], minContrast, direction);
  // Return the 8-bit color the solver measured: the unrounded OKLCH can round
  // to a neighbor just under the target once it is stored and read back.
  return themeRgbToHexColor(themeOklchToRgb(solved));
}

const STANDARD_STATUS_COLORS = {
  light: {
    error: "#fb2c36",
    errorForeground: "#c10007",
    warning: "#fe9a00",
    warningForeground: "#bb4d00",
  },
  dark: {
    error: "#fb414a",
    errorForeground: "#ff6467",
    warning: "#fe9a00",
    warningForeground: "#ffb900",
  },
} as const;

function standardStatusColors(canvas: ThemeRgbColor): {
  error: string;
  errorForeground: string;
  errorSurface: string;
  warning: string;
  warningForeground: string;
  warningSurface: string;
} {
  const appearance: ThemeAppearance = themeRelativeLuminance(canvas) < 0.179 ? "dark" : "light";
  const standard = STANDARD_STATUS_COLORS[appearance];
  const surfaceMix = appearance === "dark" ? 0.16 : 0.08;
  const surfaceOf = (value: string) =>
    mixThemeRgbColors(canvas, parseThemeRgbColor(value, canvas), surfaceMix);
  const readableOn = (foreground: string, surface: ThemeRgbColor) =>
    pipe(
      parseThemeRgbColor(foreground, canvas),
      themeRgbToOklch,
      (color) =>
        solveOklchLightness(color, [surface], 4.6, appearance === "dark" ? "lighter" : "darker"),
      themeOklchToThemeColor,
    );
  const errorSurface = surfaceOf(standard.error);
  const warningSurface = surfaceOf(standard.warning);
  return {
    error: toCanonicalThemeColor(standard.error)!,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: themeRgbToThemeColor(errorSurface),
    warning: toCanonicalThemeColor(standard.warning)!,
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: themeRgbToThemeColor(warningSurface),
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
  // At luminance 0.179, black and white text have equal contrast.
  const dark = themeRelativeLuminance(canvasRgb) < 0.179;
  const hue = accent.C < 0.02 ? canvas.h : accent.h;
  const tintC = Math.min(0.045, Math.max(0.008, accent.C * 0.22));
  const step = dark ? 1 : -1;

  const surfaceAt = (deltaL: number, chroma = tintC): ThemeOklch => ({
    L: Math.min(0.98, Math.max(0.05, canvas.L + step * deltaL)),
    C: chroma,
    h: hue,
  });
  const themeColor = (color: ThemeOklch) => themeOklchToThemeColor(color);

  const textBase: ThemeOklch = {
    L: dark ? 0.95 : 0.2,
    C: Math.min(0.035, accent.C * 0.25),
    h: hue,
  };
  const text = solveOklchLightness(textBase, [canvasRgb], 7, dark ? "lighter" : "darker");
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
  const surfaceRaisedRgb = themeOklchToRgb(surfaceRaised);
  const surfaceOverlay = surfaceAt(0.075);
  const border = surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, accent.C * 0.35));
  const input = surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, accent.C * 0.4));
  const secondary = surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, accent.C * 0.5));
  const secondaryRgb = themeOklchToRgb(secondary);
  const muted = surfaceAt(dark ? 0.06 : 0.04, Math.min(0.06, accent.C * 0.35));
  const mutedRgb = themeOklchToRgb(muted);
  const accentSurface = surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, accent.C * 0.55));
  const accentSurfaceRgb = themeOklchToRgb(accentSurface);
  const messageSurface = surfaceAt(dark ? 0.16 : 0.1, Math.min(0.13, accent.C * 0.6));
  const messageSurfaceRgb = themeOklchToRgb(messageSurface);
  const codeBackground = surfaceAt(0.035, tintC * 0.8);
  const updateSurface = surfaceAt(dark ? 0.14 : 0.09, Math.min(0.12, accent.C * 0.55));

  const foregroundOn = (surfaceRgb: ThemeRgbColor): string =>
    themeOklchToThemeColor(
      solveOklchLightness(textBase, [surfaceRgb], 4.6, dark ? "lighter" : "darker"),
    );
  const mutedForeground = themeRgbToThemeColor(readableThemeText(mutedRgb, textRgb, 1, 4.6));
  const placeholder = themeRgbToThemeColor(readableThemeText(surfaceRaisedRgb, textRgb, 1, 4.6));

  const searchMatch = themeOklchToRgb(surfaceAt(0.22, Math.min(0.12, accent.C)));
  const searchMatchActive = themeOklchToRgb(surfaceAt(0.4, Math.min(0.18, accent.C)));

  const actionHover: ThemeOklch = { ...action, L: action.L + (dark ? 0.06 : -0.06) };

  return {
    ...defaults,
    ...standardStatusColors(canvasRgb),
    canvas: themeRgbToThemeColor(canvasRgb),
    chrome: themeRgbToThemeColor(canvasRgb),
    toolbar: themeRgbToThemeColor(canvasRgb),
    toolbarForeground: themeRgbToThemeColor(textRgb),
    toolbarBorder: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.08, accent.C * 0.4))),
    toolbarControl: themeColor(surfaceAt(dark ? 0.09 : 0.05, tintC * 1.3)),
    toolbarControlForeground: themeRgbToThemeColor(textRgb),
    toolbarControlHover: themeColor(surfaceAt(dark ? 0.14 : 0.09, tintC * 1.6)),
    surface: themeColor(surface),
    surfaceRaised: themeColor(surfaceRaised),
    surfaceOverlay: themeColor(surfaceOverlay),
    text: themeRgbToThemeColor(textRgb),
    textMuted: themeRgbToThemeColor(textMutedRgb),
    border: themeColor(border),
    input: themeColor(input),
    focus: themeRgbToThemeColor(accentRgb),
    accent: themeRgbToThemeColor(accentRgb),
    accentForeground: themeRgbToThemeColor(accentForeground),
    secondary: themeColor(secondary),
    secondaryForeground: foregroundOn(secondaryRgb),
    muted: themeColor(muted),
    mutedForeground,
    placeholder,
    secondaryLabel: themeRgbToThemeColor(textMutedRgb),
    iconMuted: themeRgbToThemeColor(textMutedRgb),
    update: themeRgbToThemeColor(accentRgb),
    updateForeground: foregroundOn(themeOklchToRgb(updateSurface)),
    updateSurface: themeColor(updateSurface),
    accentSurface: themeColor(accentSurface),
    accentSurfaceForeground: foregroundOn(accentSurfaceRgb),
    messageSurface: themeColor(messageSurface),
    messageForeground: foregroundOn(messageSurfaceRgb),
    messageAction: themeRgbToThemeColor(actionRgb),
    messageActionForeground: themeRgbToThemeColor(actionForeground),
    messageActionHover: themeColor(actionHover),
    codeBackground: themeColor(codeBackground),
    codeForeground: themeRgbToThemeColor(textRgb),
    searchMatchBackground: themeRgbToThemeColor(searchMatch),
    searchMatchForeground: themeRgbToThemeColor(readableThemeForeground(searchMatch)),
    searchMatchActiveBackground: themeRgbToThemeColor(searchMatchActive),
    searchMatchActiveForeground: themeRgbToThemeColor(readableThemeForeground(searchMatchActive)),
    sidebar: themeColor(sidebar),
    sidebarForeground: foregroundOn(sidebarRgb),
    sidebarMutedForeground: themeRgbToThemeColor(standardMutedThemeText(sidebarRgb, textRgb)),
    sidebarControlSurface: themeColor(surfaceAt(dark ? 0.1 : 0.07, tintC * 1.5)),
    sidebarRowHover: themeColor(surfaceAt(dark ? 0.08 : 0.06, Math.min(0.08, accent.C * 0.45))),
    sidebarRowActive: themeColor(surfaceAt(dark ? 0.12 : 0.09, Math.min(0.1, accent.C * 0.55))),
    sidebarRowSelected: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, accent.C * 0.6))),
    sidebarBorder: themeColor(surfaceAt(dark ? 0.17 : 0.12, Math.min(0.08, accent.C * 0.4))),
    terminalBackground: themeRgbToThemeColor(canvasRgb),
    terminalForeground: themeRgbToThemeColor(textRgb),
    terminalCursor: themeRgbToThemeColor(accentRgb),
    terminalSelection: themeColor(surfaceAt(dark ? 0.18 : 0.12, Math.min(0.12, accent.C * 0.55))),
  };
}

export function themeContrastRatio(first: ThemeRgbColor, second: ThemeRgbColor): number {
  const firstLuminance = themeRelativeLuminance(first);
  const secondLuminance = themeRelativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
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

export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? T3_CHAT_THEME.variants!.dark! : T3_CHAT_THEME.colors;
}

export function updateThemeColorFamily(
  appearance: ThemeAppearance,
  colors: ThemeColors,
  role: ThemeColorRole,
  value: string,
): ThemeColors {
  const parsedSelected = parseThemeColor(value);
  if (!parsedSelected) return { ...colors, [role]: value };
  const normalized = formatOklchThemeColor(parsedSelected.color, parsedSelected.alpha);

  const canvas = parseThemeRgbColor(
    colors.canvas,
    appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  );
  const selected = themeOklchToRgb(parsedSelected.color);
  const selectedOn = (background: ThemeRgbColor) =>
    mixThemeRgbColors(background, selected, parsedSelected.alpha);
  const selectedOnCanvas = selectedOn(canvas);
  const accent = parseThemeRgbColor(colors.accent, { r: 168, g: 67, b: 112 });
  const canvasIsDark = themeRelativeLuminance(canvas) < 0.179;
  const terminalIsDark = themeRelativeLuminance(selectedOnCanvas) < 0.179;
  const colorOf = (color: ThemeRgbColor) => themeRgbToThemeColor(color);
  const foregroundOn = (background: ThemeRgbColor) => colorOf(readableThemeForeground(background));
  const selectedToneOn = (background: ThemeRgbColor) =>
    themeOklchToThemeColor(
      solveOklchLightness(
        parsedSelected.color,
        [background],
        4.6,
        themeRelativeLuminance(background) < 0.179 ? "lighter" : "darker",
      ),
    );
  const statusColors = () => {
    const surface = mixThemeRgbColors(canvas, selectedOnCanvas, canvasIsDark ? 0.16 : 0.08);
    return {
      foreground: selectedToneOn(surface),
      surface: colorOf(surface),
    };
  };

  switch (role) {
    case "canvas":
      return {
        ...colors,
        canvas: normalized,
        chrome: normalized,
        toolbar: normalized,
        terminalBackground: normalized,
      };
    case "surface":
    case "surfaceRaised":
    case "surfaceOverlay":
    case "input":
    case "sidebarControlSurface":
      return { ...colors, [role]: normalized };
    case "text":
      return {
        ...colors,
        text: normalized,
        toolbarForeground: normalized,
        toolbarControlForeground: normalized,
      };
    case "mutedForeground":
      return {
        ...colors,
        textMuted: normalized,
        mutedForeground: normalized,
        placeholder: normalized,
        secondaryLabel: normalized,
        iconMuted: normalized,
        sidebarMutedForeground: normalized,
      };
    case "border":
      return {
        ...colors,
        border: normalized,
        toolbarBorder: normalized,
        sidebarBorder: normalized,
      };
    case "secondary":
      return {
        ...colors,
        secondary: normalized,
        secondaryForeground: foregroundOn(selectedOnCanvas),
        muted: normalized,
        toolbarControl: normalized,
      };
    case "accentSurface":
      return {
        ...colors,
        accentSurface: normalized,
        accentSurfaceForeground: foregroundOn(selectedOnCanvas),
        toolbarControlHover: normalized,
      };
    case "accent": {
      const updateSurface = mixThemeRgbColors(canvas, selectedOnCanvas, canvasIsDark ? 0.32 : 0.16);
      return {
        ...colors,
        accent: normalized,
        accentForeground: foregroundOn(selectedOnCanvas),
        focus: normalized,
        update: normalized,
        updateForeground: selectedToneOn(updateSurface),
        updateSurface: colorOf(updateSurface),
        terminalCursor: normalized,
      };
    }
    case "messageAction": {
      const actionForeground = readableThemeForeground(selectedOnCanvas);
      const towardOpposite =
        actionForeground === THEME_LIGHT_FOREGROUND || actionForeground === THEME_WHITE_FOREGROUND
          ? THEME_BLACK_FOREGROUND
          : THEME_WHITE_FOREGROUND;
      const actionHover = mixThemeRgbColors(selected, towardOpposite, 0.12);
      return {
        ...colors,
        messageAction: normalized,
        messageActionForeground: colorOf(actionForeground),
        messageActionHover: formatOklchThemeColor(
          themeRgbToOklch(actionHover),
          parsedSelected.alpha,
        ),
      };
    }
    case "messageSurface":
      return {
        ...colors,
        messageSurface: normalized,
        messageForeground: foregroundOn(selectedOnCanvas),
      };
    case "searchMatchBackground":
      return {
        ...colors,
        searchMatchBackground: colorOf(selectedOnCanvas),
        searchMatchForeground: foregroundOn(selectedOnCanvas),
      };
    case "searchMatchActiveBackground":
      return {
        ...colors,
        searchMatchActiveBackground: colorOf(selectedOnCanvas),
        searchMatchActiveForeground: foregroundOn(selectedOnCanvas),
      };
    case "codeBackground":
      return {
        ...colors,
        codeBackground: normalized,
        codeForeground: foregroundOn(selectedOnCanvas),
      };
    case "sidebar":
      return {
        ...colors,
        sidebar: normalized,
        sidebarForeground: foregroundOn(selectedOnCanvas),
      };
    case "sidebarRowSelected": {
      const sidebar = parseThemeRgbColor(colors.sidebar, canvas);
      const selectedOnSidebar = selectedOn(sidebar);
      return {
        ...colors,
        sidebarRowHover: colorOf(mixThemeRgbColors(sidebar, selectedOnSidebar, 0.5)),
        sidebarRowActive: colorOf(mixThemeRgbColors(sidebar, selectedOnSidebar, 0.8)),
        sidebarRowSelected: normalized,
      };
    }
    case "terminalBackground": {
      const terminalForeground = readableThemeForeground(selectedOnCanvas);
      return {
        ...colors,
        terminalBackground: normalized,
        terminalForeground: colorOf(terminalForeground),
        terminalSelection: colorOf(
          mixThemeRgbColors(selectedOnCanvas, accent, terminalIsDark ? 0.35 : 0.18),
        ),
      };
    }
    case "error": {
      const status = statusColors();
      return {
        ...colors,
        error: normalized,
        errorForeground: status.foreground,
        errorSurface: status.surface,
      };
    }
    case "warning": {
      const status = statusColors();
      return {
        ...colors,
        warning: normalized,
        warningForeground: status.foreground,
        warningSurface: status.surface,
      };
    }
    default:
      return { ...colors, [role]: normalized };
  }
}

// Version two resolves families in dependency order, independent of editor presentation.
const THEME_PALETTE_ROLES: ReadonlyArray<ThemeColorRole> = [
  "canvas",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "mutedForeground",
  "border",
  "input",
  "secondary",
  "accentSurface",
  "accent",
  "messageAction",
  "messageSurface",
  "codeBackground",
  "searchMatchBackground",
  "searchMatchActiveBackground",
  "sidebar",
  "sidebarControlSurface",
  "sidebarRowSelected",
  "terminalBackground",
  "error",
  "warning",
];

const resolvedSources = new WeakMap<ThemeSource, Partial<Record<ThemeAppearance, ThemeColors>>>();

// Version two's generator and defaults are saved-file semantics; preserve their pinned outputs.
export function resolveThemeSource(source: ThemeSource, appearance: ThemeAppearance): ThemeColors {
  const cached = resolvedSources.get(source)?.[appearance];
  if (cached) return cached;
  let colors = source.seed
    ? createVividThemeColors(appearance, source.seed.canvas, source.seed.accent)
    : decodeThemeColors(getDefaultThemeColors(appearance));
  for (const role of THEME_PALETTE_ROLES) {
    const value = source.overrides?.[role] ?? source.palette?.[role];
    if (value !== undefined) colors = updateThemeColorFamily(appearance, colors, role, value);
  }
  // Non-family inputs remain independently addressable, including imported foregrounds.
  const resolved = decodeThemeColors({ ...colors, ...source.palette, ...source.overrides });
  resolvedSources.set(source, { ...resolvedSources.get(source), [appearance]: resolved });
  return resolved;
}

export function themeSourceFromColors(colors: ThemeColors): ThemeSource {
  return { version: 2, overrides: { ...colors } };
}

export function themeSourceForEditing(
  theme: ThemeDefinition,
  appearance: ThemeAppearance,
): ThemeSource {
  const source = theme.sources?.[appearance];
  if (source) return source;
  const colors =
    getThemeColorsForAppearance(theme, appearance) ?? getStandardThemeColors(appearance);
  if (theme.managed !== true) return themeSourceFromColors(colors);
  const guided = { version: 2, seed: { canvas: colors.canvas, accent: colors.accent } } as const;
  const generated = resolveThemeSource(guided, appearance);
  // Legacy guided saves could retain advanced edits without recording their provenance.
  const overrides = Object.fromEntries(
    THEME_COLOR_ROLES.filter((role) => colors[role] !== generated[role]).map((role) => [
      role,
      colors[role],
    ]),
  );
  if (!Object.keys(overrides).length) return guided;
  const resolved = resolveThemeSource({ ...guided, overrides }, appearance);
  return {
    ...guided,
    overrides: Object.fromEntries(
      THEME_COLOR_ROLES.filter((role) => role in overrides || colors[role] !== resolved[role]).map(
        (role) => [role, colors[role]],
      ),
    ),
  };
}

/** Authors one role in the palette, or with `null` resets it to inherit; both drop its override. */
export function setThemeSourceRole(
  source: ThemeSource,
  role: ThemeColorRole,
  value: string | null,
): ThemeSource {
  const palette: Partial<Record<ThemeColorRole, string>> = { ...source.palette };
  const overrides: Partial<Record<ThemeColorRole, string>> = { ...source.overrides };
  delete overrides[role];
  delete palette[role];
  if (value !== null) {
    const color = toCanonicalThemeColor(value);
    if (!color) throw new Error(`Invalid theme color for "${role}".`);
    palette[role] = color;
  }
  return { ...source, palette, overrides };
}

export function parseThemeSource(value: unknown): ThemeSource {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 2) {
    throw new Error("Unsupported authored theme version.");
  }
  const record = value as Record<string, unknown>;
  const parseInputs = (input: unknown): ThemeColorInputs => {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new Error("Invalid theme inputs.");
    const result: Partial<Record<ThemeColorRole, string>> = {};
    for (const [role, value] of Object.entries(input)) {
      if (DEPRECATED_THEME_COLOR_ROLES.has(role)) continue;
      if (!(THEME_COLOR_ROLES as readonly string[]).includes(role))
        throw new Error(`Unsupported theme role "${role}".`);
      const color = toCanonicalThemeColor(value);
      if (!color) throw new Error(`Invalid theme color for "${role}".`);
      result[role as ThemeColorRole] = color;
    }
    return result;
  };
  const seed = record.seed === undefined ? undefined : parseInputs(record.seed);
  if (seed && (!seed.canvas || !seed.accent))
    throw new Error("Theme seeds need canvas and accent colors.");
  return {
    version: 2,
    ...(seed ? { seed: { canvas: seed.canvas!, accent: seed.accent! } } : {}),
    ...(record.palette === undefined ? {} : { palette: parseInputs(record.palette) }),
    ...(record.overrides === undefined ? {} : { overrides: parseInputs(record.overrides) }),
  };
}

export function resolveThemeDefinition(
  theme: ThemeDefinition,
  appearance: ThemeAppearance,
): ThemeColors | null {
  const source = theme.sources?.[appearance];
  return source
    ? resolveThemeSource(source, appearance)
    : getThemeColorsForAppearance(theme, appearance);
}
