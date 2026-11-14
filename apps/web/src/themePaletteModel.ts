import { pipe } from "effect/Function";
import type { EnvironmentTheme } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import "culori/css";
import { converter, parse } from "culori/fn";
import {
  BUILT_IN_THEMES,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  T3_CHAT_THEME,
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
  RESERVED_THEME_IDS,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariants,
} from "@t3tools/shared/themePalettes";
import {
  CONTEXT_CHIP_ACCENTS,
  contextChipColorVariable,
  type ContextChipAccentKind,
} from "./lib/contextChipAccents";
import { appAtomRegistry, subscribeAtomChanges } from "./rpc/atomRegistry";
import { primaryServerEnvironmentThemesAtom } from "./state/server";
import { createVividThemeColors } from "./themePaletteParts2";
import { APP_THEME_VARIABLES } from "./themePaletteParts3";
import { legacyThemeMode, themeIdFromPreference } from "./themePreferenceIds";
import type { ThemePreference } from "./themePreferenceIds";
import { parseThemeFile } from "./themePaletteParts4";

export function getStandardThemeColors(appearance: ThemeAppearance): ThemeColors {
  if (appearance === "dark") {
    return (standardDarkThemeColors ??= decodeThemeColors({
      ...T3_CODE_DARK_THEME_COLORS,
      canvas: "#000000",
    }));
  }
  return (standardLightThemeColors ??= decodeThemeColors(T3_CODE_LIGHT_THEME_COLORS));
}

// index.css paints the light bubble a step darker than the shared palette mobile uses.
const STANDARD_WEB_PAINTED_COLORS: Record<ThemeAppearance, Partial<ThemeColors>> = {
  light: { messageSurface: "#ebebed" },
  dark: { canvas: "#000000", messageSurface: "#1e1e1e" },
};

/** The standard theme as index.css paints it, for solves that measure the page. */
export function getStandardPaintedThemeColors(appearance: ThemeAppearance): ThemeColors {
  return { ...getStandardThemeColors(appearance), ...STANDARD_WEB_PAINTED_COLORS[appearance] };
}

export type ThemeRgbColor = {
  r: number;
  g: number;
  b: number;
};

export type ThemeOklch = { L: number; C: number; h: number };
type ParsedThemeColor = { color: ThemeOklch; alpha: number };

let standardLightThemeColors: ThemeColors | undefined;
let standardDarkThemeColors: ThemeColors | undefined;

export const THEME_LIGHT_FOREGROUND: ThemeRgbColor = { r: 255, g: 250, b: 255 };
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

function formatThemeColorNumber(value: number, precision: number): string {
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value;
  return rounded.toFixed(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, "$1");
}

export function formatOklchThemeColor(color: ThemeOklch, alpha = 1): string {
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

export function parseThemeRgbColor(value: string, fallback: ThemeRgbColor): ThemeRgbColor {
  const parsed = parseThemeColor(value);
  return parsed ? themeOklchToRgb(parsed.color) : fallback;
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

export function themeRgbToThemeColor(color: ThemeRgbColor): string {
  return formatOklchThemeColor(themeRgbToOklch(color));
}

function decodeThemeColors(colors: ThemeColors): ThemeColors {
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

export function canonicalizeThemeDefinition(theme: ThemeDefinition): ThemeDefinition {
  return {
    ...theme,
    colors: decodeThemeColors(theme.colors),
    ...(theme.variants
      ? {
          variants: Object.fromEntries(
            Object.entries(theme.variants).map(([appearance, colors]) => [
              appearance,
              decodeThemeColors(colors),
            ]),
          ) as ThemeVariants,
        }
      : {}),
  };
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

function linearChannelToSrgb(channel: number, round = true): number {
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

function oklchToRgbUnclamped({ L, C, h }: ThemeOklch): { r: number; g: number; b: number } {
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

export function themeOklchToThemeColor(color: ThemeOklch): string {
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

const CONTEXT_CHIP_CONTRAST = 5;
const CONTEXT_CHIP_MESSAGE_VARIABLE = "--context-chip-message";
const CONTEXT_CHIP_INVALID_VARIABLE = "--context-chip-invalid";

export function contextChipVariables(colors: ThemeColors): Readonly<Record<string, string>> {
  // CSS paints surfaces from their unrounded OKLCH, so measure them unrounded.
  const parsedCanvas = parseThemeColor(colors.canvas);
  const canvas = parsedCanvas ? themeOklchToRgb(parsedCanvas.color, false) : THEME_WHITE_FOREGROUND;
  const onCanvas = (value: string) => {
    const parsed = parseThemeColor(value);
    return parsed
      ? mixThemeRgbColors(canvas, themeOklchToRgb(parsed.color, false), parsed.alpha)
      : canvas;
  };
  const isDark = (color: ThemeRgbColor) => themeRelativeLuminance(color) < 0.179;
  const messageMatchesCanvas = isDark(onCanvas(colors.messageSurface)) === isDark(canvas);
  const surfaces = [canvas, onCanvas(colors.surface), onCanvas(colors.surfaceRaised)];
  if (messageMatchesCanvas) surfaces.push(onCanvas(colors.messageSurface));
  const contrastOnSurfaces = (color: ThemeRgbColor) =>
    Math.min(...surfaces.map((surface) => themeContrastRatio(color, surface)));
  const blackContrast = contrastOnSurfaces(THEME_BLACK_FOREGROUND);
  const whiteContrast = contrastOnSurfaces(THEME_WHITE_FOREGROUND);
  const direction = blackContrast >= whiteContrast ? "darker" : "lighter";
  const minContrast = Math.min(CONTEXT_CHIP_CONTRAST, Math.max(blackContrast, whiteContrast));
  const accents: Array<[string, string]> = [
    ...(Object.entries(CONTEXT_CHIP_ACCENTS) as Array<[ContextChipAccentKind, string]>).map(
      ([kind, accent]): [string, string] => [contextChipColorVariable(kind), accent],
    ),
    [CONTEXT_CHIP_INVALID_VARIABLE, colors.errorForeground],
  ];
  const variables: Record<string, string> = Object.fromEntries(
    accents.flatMap(([variable, accent]) => {
      const parsed = parseThemeColor(accent);
      if (!parsed) return [];
      const solved = solveOklchLightness(parsed.color, surfaces, minContrast, direction);
      return [[variable, themeRgbToHexColor(themeOklchToRgb(solved))]];
    }),
  );
  if (!messageMatchesCanvas) variables[CONTEXT_CHIP_MESSAGE_VARIABLE] = colors.messageForeground;
  return variables;
}

export function applyContextChipVariables(root: HTMLElement, colors: ThemeColors): void {
  const variables = contextChipVariables(colors);
  root.style.removeProperty(CONTEXT_CHIP_MESSAGE_VARIABLE);
  root.style.removeProperty(CONTEXT_CHIP_INVALID_VARIABLE);
  for (const [variable, value] of Object.entries(variables)) {
    root.style.setProperty(variable, value);
  }
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

export function standardStatusColors(canvas: ThemeRgbColor): {
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

function themeContrastRatio(first: ThemeRgbColor, second: ThemeRgbColor): number {
  const firstLuminance = themeRelativeLuminance(first);
  const secondLuminance = themeRelativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function readableThemeForeground(background: ThemeRgbColor): ThemeRgbColor {
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

export function readableThemeText(
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

export function standardMutedThemeText(
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

export const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = BUILT_IN_THEMES;


export function themeAllowsSidebarArtwork(theme: ThemePreference): boolean {
  const themeId = themeIdFromPreference(theme);
  return (
    BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === themeId)?.sidebarArtwork ===
    true
  );
}

/** Every selection path must check single-appearance themes to keep mix and appearance tiles in sync. */
export function singleAppearanceOf(theme: ThemeDefinition): ThemeAppearance | null {
  const modes = getThemeModes(theme);
  return modes.length === 1 ? modes[0]! : null;
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


export function themeIdFromName(name: string): string {
  const label = name.trim().toLowerCase();
  const normalized = label
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (normalized || !label) return normalized || "custom-theme";

  // Names without ASCII letters or digits still need independent, stable ids.
  let hash = 2_166_136_261;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `theme-${(hash >>> 0).toString(36)}`;
}

export class ThemeLibraryStorageError extends Schema.TaggedError<ThemeLibraryStorageError>()(
  "ThemeLibraryStorageError",
  {
    storageKey: Schema.String,
    operation: Schema.Literals(["read", "write"]),
    reason: Schema.Literals(["malformed", "storage-unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const direction = this.operation === "read" ? "from" : "to";
    return `Failed to ${this.operation} the theme library ${direction} ${this.storageKey}.`;
  }
}
