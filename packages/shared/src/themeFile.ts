import "culori/css";
import { converter, parse } from "culori/fn";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BUILT_IN_THEME_IDS,
  MOBILE_DEFAULT_THEME_ID,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
} from "./themePalettes.ts";

export const THEME_FILE_VERSION = 1 as const;
export const MAX_THEME_FILE_BYTES = 64 * 1024;
export const MAX_IMPORTED_THEMES = 20;
export const MAX_IMPORTED_THEMES_BYTES = 256 * 1024;

export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>;
export type ThemeVariantOverrides = Readonly<Partial<Record<ThemeAppearance, ThemeColorOverrides>>>;
export type PortableThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColorOverrides;
  variants?: ThemeVariantOverrides;
  collection?: Readonly<{ id: string; label: string }>;
  managed?: true;
}>;
type PortableThemeFileBuilder = {
  -readonly [Key in keyof PortableThemeFile]: PortableThemeFile[Key];
};

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
const RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  "system",
  "light",
  "dark",
  MOBILE_DEFAULT_THEME_ID,
  ...BUILT_IN_THEME_IDS,
  "t3-chat-dark",
  "t3-grove",
  "t3-ocean",
  "t3-ember",
  "t3-iris",
]);
const toOklch = converter("oklch");

type ThemeOklch = Readonly<{ L: number; C: number; h: number }>;
type ThemeRgbColor = Readonly<{ r: number; g: number; b: number }>;

const ThemeColorOverridesInput = Schema.Record(Schema.String, Schema.String);
const PortableThemeFileInput = Schema.Struct({
  version: Schema.Number,
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  appearance: Schema.String,
  colors: ThemeColorOverridesInput,
  variants: Schema.optionalKey(Schema.Record(Schema.String, ThemeColorOverridesInput)),
  collection: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
    }),
  ),
  managed: Schema.optionalKey(Schema.Boolean),
});
export type PortableThemeFileInput = typeof PortableThemeFileInput.Type;

export const decodePortableThemeFileInput = Schema.decodeUnknownSync(PortableThemeFileInput);
const decodeUnknownArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodePortableThemeFileInputOption = Schema.decodeUnknownOption(PortableThemeFileInput);

function isAppearance(value: string): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

function isThemeId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

function isLabel(value: string): boolean {
  return value.trim().length > 0 && value.trim().length <= 48;
}

function formatNumber(value: number, precision: number): string {
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value;
  return rounded.toFixed(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, "$1");
}

/** Converts every supported CSS literal into the portable theme representation. */
export function canonicalThemeColor(value: string): string | null {
  const input = value.trim();
  const parsed = parse(input);
  if (!parsed) return null;
  const color = toOklch(parsed);
  const lightness = color.l ?? 0;
  const chroma = color.c ?? 0;
  const hue = color.h ?? 0;
  const alpha = /\/\s*none\s*\)$/i.test(input) ? 0 : (color.alpha ?? 1);
  if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return null;
  const normalizedLightness = Math.min(1, Math.max(0, lightness));
  const normalizedChroma = Math.max(0, chroma);
  const normalizedHue = normalizedChroma < 0.0000005 ? 0 : ((hue % 360) + 360) % 360;
  const body = `${formatNumber(normalizedLightness, 6)} ${formatNumber(normalizedChroma, 6)} ${formatNumber(normalizedHue, 3)}`;
  const normalizedAlpha = Math.min(1, Math.max(0, alpha));
  return normalizedAlpha < 1
    ? `oklch(${body} / ${formatNumber(normalizedAlpha, 4)})`
    : `oklch(${body})`;
}

/** React Native and native bridges use sRGB hex, including CSS-order alpha. */
export function themeColorToHex(value: string): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  const color = toOklch(parsed);
  const lightness = color.l ?? 0;
  const chroma = color.c ?? 0;
  const hue = color.h ?? 0;
  const alpha = color.alpha ?? 1;
  if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return null;
  const rgb = themeOklchToRgb({ L: lightness, C: chroma, h: hue });
  const opaque = `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
  if (alpha >= 1) return opaque;
  return `${opaque}${Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

function themeOklchToRgb(color: ThemeOklch): ThemeRgbColor {
  const linear = oklchToRgbUnclamped(mapThemeOklchToSrgbGamut(color));
  return {
    r: linearChannelToSrgb(linear.r),
    g: linearChannelToSrgb(linear.g),
    b: linearChannelToSrgb(linear.b),
  };
}

function oklchToRgbUnclamped({ L, C, h }: ThemeOklch) {
  const hue = (h * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function mapThemeOklchToSrgbGamut(color: ThemeOklch): ThemeOklch {
  const isInGamut = (chroma: number) => {
    const linear = oklchToRgbUnclamped({ ...color, C: chroma });
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

function linearChannelToSrgb(channel: number): number {
  const srgb = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, srgb)) * 255);
}

export function themeIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function parseCollection(value: PortableThemeFileInput["collection"]) {
  if (value === undefined) return undefined;
  if (!/^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id) || !isLabel(value.label)) {
    throw new Error("Theme collections need a valid id and label.");
  }
  return { id: value.id, label: value.label.trim() };
}

function isThemeColorRole(value: string): value is ThemeColorRole {
  return THEME_COLOR_ROLE_SET.has(value);
}

function parseColorOverrides(value: PortableThemeFileInput["colors"]) {
  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!isThemeColorRole(role)) {
      throw new Error(`"${role}" is not a supported theme color role.`);
    }
    const normalized = canonicalThemeColor(color);
    if (!normalized) {
      throw new Error(`The color for "${role}" must be a literal CSS color.`);
    }
    overrides[role] = normalized;
  }
  if (Object.keys(overrides).length === 0) {
    throw new Error("Add at least one color role to the theme file.");
  }
  return overrides;
}

export function parsePortableThemeFile(value: PortableThemeFileInput): PortableThemeFile {
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }
  if (!isLabel(value.name)) {
    throw new Error("Theme files need a name (48 characters or fewer).");
  }
  if (!isAppearance(value.appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }
  const id = value.id === undefined ? themeIdFromName(value.name) : value.id;
  if (!isThemeId(id)) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`);

  const variants: Partial<Record<ThemeAppearance, ThemeColorOverrides>> = {};
  if (value.variants !== undefined) {
    for (const [appearance, colors] of Object.entries(value.variants)) {
      if (!isAppearance(appearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }
      if (appearance === value.appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }
      variants[appearance] = parseColorOverrides(colors);
    }
  }
  const collection = parseCollection(value.collection);
  const result: PortableThemeFileBuilder = {
    version: THEME_FILE_VERSION,
    id,
    name: value.name.trim(),
    appearance: value.appearance,
    colors: parseColorOverrides(value.colors),
  };
  if (Object.keys(variants).length > 0) result.variants = variants;
  if (collection) result.collection = collection;
  if (value.managed === true) result.managed = true;
  return result;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function parsePortableThemeFileJson(value: string): PortableThemeFile {
  if (utf8ByteLength(value) > MAX_THEME_FILE_BYTES) {
    throw new Error("Theme files must be 64 KB or smaller.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Theme files must contain valid JSON.");
  }
  return parsePortableThemeFile(decodePortableThemeFileInput(parsed));
}

export function addPortableTheme(
  current: ReadonlyArray<PortableThemeFile>,
  theme: PortableThemeFile,
): ReadonlyArray<PortableThemeFile> {
  if (current.some((candidate) => candidate.id === theme.id)) {
    throw new Error(`A theme named "${theme.name}" is already installed.`);
  }
  if (current.length >= MAX_IMPORTED_THEMES) {
    throw new Error(`Up to ${MAX_IMPORTED_THEMES} imported themes are supported.`);
  }
  const next = [...current, theme];
  if (utf8ByteLength(JSON.stringify(next)) > MAX_IMPORTED_THEMES_BYTES) {
    throw new Error("Imported themes may use up to 256 KB of device storage.");
  }
  return next;
}

export function sanitizePortableThemes(
  value: ReadonlyArray<PortableThemeFileInput> | undefined,
): ReadonlyArray<PortableThemeFile> {
  const candidates = decodeUnknownArray(value);
  if (Option.isNone(candidates)) return [];
  const themes: PortableThemeFile[] = [];
  for (const rawCandidate of candidates.value) {
    if (themes.length >= MAX_IMPORTED_THEMES) break;
    const candidate = decodePortableThemeFileInputOption(rawCandidate);
    if (Option.isNone(candidate)) continue;
    try {
      const theme = parsePortableThemeFile(candidate.value);
      if (themes.some((existing) => existing.id === theme.id)) continue;
      const next = [...themes, theme];
      if (utf8ByteLength(JSON.stringify(next)) > MAX_IMPORTED_THEMES_BYTES) continue;
      themes.push(theme);
    } catch {
      // Invalid persisted entries are isolated so the remaining library still loads.
    }
  }
  return themes;
}
