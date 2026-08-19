import * as Schema from "effect/Schema";
import "culori/css";
import { converter, parse } from "culori/fn";
import {
  BUILT_IN_THEMES,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  T3_CHAT_THEME,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariants,
} from "@t3tools/shared/themePalettes";

export { EMBER_THEME, GROVE_THEME, IRIS_THEME, OCEAN_THEME, T3_CHAT_THEME, THEME_COLOR_ROLES };
export type { ThemeAppearance, ThemeColorRole, ThemeColors, ThemeDefinition, ThemeVariants };

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
export const CUSTOM_THEMES_STORAGE_KEY = "t3code:themes:v1";
export const THEME_FOLLOW_SYSTEM_STORAGE_KEY = "t3code:theme-follow-system";
export const THEME_APPEARANCE_MODE_STORAGE_KEY = "t3code:theme-appearance-mode";
export const THEME_HALVES_STORAGE_KEY = "t3code:theme-halves:v1";

const LEGACY_T3_CHAT_DARK_THEME_ID = "t3-chat-dark";

export const ThemePreference = Schema.String;
export type ThemePreference = typeof ThemePreference.Type;

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
const LEGACY_THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set([
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "textMuted",
  "focus",
  "accentForeground",
  "secondaryForeground",
  "muted",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "errorForeground",
  "errorSurface",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurfaceForeground",
  "messageForeground",
  "messageActionForeground",
  "messageActionHover",
  "codeForeground",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarBorder",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
]);
export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>;
export type ThemeVariantOverrides = Readonly<Partial<Record<ThemeAppearance, ThemeColorOverrides>>>;
export type ThemePreferenceMode = ThemeAppearance | "system";
export type ThemeCollection = Readonly<{ id: string; label: string }>;
export type ThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColorOverrides;
  variants?: ThemeVariantOverrides;
  collection?: ThemeCollection;
  managed?: boolean;
}>;

const RESERVED_THEME_IDS = new Set([
  "system",
  "light",
  "dark",
  T3_CHAT_THEME_ID,
  GROVE_THEME_ID,
  OCEAN_THEME_ID,
  EMBER_THEME_ID,
  IRIS_THEME_ID,
  LEGACY_T3_CHAT_DARK_THEME_ID,
  "t3-grove",
  "t3-ocean",
  "t3-ember",
  "t3-iris",
]);

const customThemeListeners = new Set<() => void>();
type CustomThemeLibrarySnapshot =
  | Readonly<{
      status: "ready";
      storedThemes: ReadonlyArray<unknown>;
      themes: ReadonlyArray<ThemeDefinition>;
    }>
  | Readonly<{ status: "unavailable"; reason: "malformed" }>
  | Readonly<{ status: "unavailable"; reason: "storage-unavailable"; cause: unknown }>;

let customThemeLibrarySnapshot: CustomThemeLibrarySnapshot | null = null;
const themePreviewListeners = new Set<() => void>();
let themePreviewSidebarArtwork: boolean | null = null;

export function getThemePreviewSidebarArtwork(): boolean | null {
  return themePreviewSidebarArtwork;
}

export function subscribeToThemePreview(listener: () => void): () => void {
  themePreviewListeners.add(listener);
  return () => themePreviewListeners.delete(listener);
}

function setThemePreviewSidebarArtwork(next: boolean | null): void {
  if (themePreviewSidebarArtwork === next) return;
  themePreviewSidebarArtwork = next;
  for (const listener of themePreviewListeners) listener();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

export function isThemeColor(value: unknown): value is string {
  return typeof value === "string" && toCanonicalThemeColor(value) !== null;
}

function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

function parseThemeCollection(value: unknown): ThemeCollection | undefined {
  return isRecord(value) &&
    typeof value.id === "string" &&
    /^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id) &&
    isThemeLabel(value.label)
    ? { id: value.id, label: value.label.trim() }
    : undefined;
}

function parseStoredThemeColors(value: unknown, appearance: ThemeAppearance): ThemeColors | null {
  if (!isRecord(value)) return null;

  const colors: Partial<Record<ThemeColorRole, string>> = {
    ...getDefaultThemeColors(appearance),
  };
  // Tolerate unknown roles and malformed values so themes saved by other
  // builds (for example one that adds a new role) keep their remaining colors.
  for (const [role, color] of Object.entries(value)) {
    const normalized = toCanonicalThemeColor(color);
    if (THEME_COLOR_ROLE_SET.has(role) && normalized) {
      colors[role as ThemeColorRole] = normalized;
    }
  }
  return colors as ThemeColors;
}

function parseStoredThemeVariants(
  value: unknown,
  baseAppearance: ThemeAppearance,
): ThemeVariants | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const [appearance, colors] of Object.entries(value)) {
    if (!isThemeAppearance(appearance)) return null;
    // A variant matching the base appearance would be shadowed by the base
    // colors; drop it so the theme round-trips through parseThemeFile.
    if (appearance === baseAppearance) continue;
    const parsedColors = parseStoredThemeColors(colors, appearance);
    if (!parsedColors) return null;
    variants[appearance] = parsedColors;
  }
  return Object.keys(variants).length > 0 ? variants : undefined;
}

function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null;
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null;
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null;
  const colors = parseStoredThemeColors(value.colors, value.appearance);
  if (!colors) return null;
  const variants = parseStoredThemeVariants(value.variants, value.appearance);
  if (value.variants !== undefined && variants === null) return null;
  const collection = parseThemeCollection(value.collection);

  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors,
    ...(variants ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

function parseStoredThemes(storedThemes: ReadonlyArray<unknown>): ReadonlyArray<ThemeDefinition> {
  const themes: ThemeDefinition[] = [];
  for (const value of storedThemes) {
    const theme = parseStoredTheme(value);
    if (theme && !themes.some((existing) => existing.id === theme.id)) {
      themes.push(theme);
    }
  }
  return themes;
}

function readCustomThemeLibrarySnapshot(): CustomThemeLibrarySnapshot {
  if (typeof window === "undefined") {
    return { status: "ready", storedThemes: [], themes: [] };
  }

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  } catch (cause) {
    return { status: "unavailable", reason: "storage-unavailable", cause };
  }
  if (!raw) return { status: "ready", storedThemes: [], themes: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unavailable", reason: "malformed" };
  }
  if (!Array.isArray(parsed)) return { status: "unavailable", reason: "malformed" };

  return { status: "ready", storedThemes: parsed, themes: parseStoredThemes(parsed) };
}

function getCustomThemeLibrarySnapshot(): CustomThemeLibrarySnapshot {
  if (customThemeLibrarySnapshot === null) {
    customThemeLibrarySnapshot = readCustomThemeLibrarySnapshot();
  }
  return customThemeLibrarySnapshot;
}

function notifyCustomThemeListeners() {
  for (const listener of customThemeListeners) listener();
}

export function invalidateCustomThemes() {
  customThemeLibrarySnapshot = null;
  notifyCustomThemeListeners();
}

export function getCustomThemes(): ReadonlyArray<ThemeDefinition> {
  const snapshot = getCustomThemeLibrarySnapshot();
  return snapshot.status === "ready" ? snapshot.themes : [];
}

export function getStoredCustomThemeCollection(
  collectionId: string,
): ReadonlyArray<ThemeDefinition> {
  return readWritableCustomThemeLibrary().themes.filter(
    (theme) => theme.collection?.id === collectionId,
  );
}

export function subscribeToCustomThemes(listener: () => void): () => void {
  customThemeListeners.add(listener);
  if (typeof window === "undefined") {
    return () => customThemeListeners.delete(listener);
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_THEMES_STORAGE_KEY || event.key === null) {
      invalidateCustomThemes();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    customThemeListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

// Earlier builds shipped every maintainer theme under a t3- prefix; only the
// genuinely T3-branded palette keeps it. Stored preferences and mixes with the
// old ids stay readable through this alias table.
const LEGACY_THEME_ID_ALIASES: Readonly<Record<string, string>> = {
  [LEGACY_T3_CHAT_DARK_THEME_ID]: T3_CHAT_THEME_ID,
  "t3-grove": GROVE_THEME_ID,
  "t3-ocean": OCEAN_THEME_ID,
  "t3-ember": EMBER_THEME_ID,
  "t3-iris": IRIS_THEME_ID,
};

function normalizeThemeId(themeId: string): string {
  return LEGACY_THEME_ID_ALIASES[themeId] ?? themeId;
}

/**
 * Map a stored preference onto the id the runtime applies, so selection state
 * matches the theme cards. The legacy dark-variant id stays as-is because it
 * still carries the appearance hint getThemePreferenceMode reads.
 */
export function canonicalThemePreference(theme: string): string {
  return theme === LEGACY_T3_CHAT_DARK_THEME_ID ? theme : normalizeThemeId(theme);
}

function themeIdFromPreference(theme: ThemePreference): string {
  return normalizeThemeId(theme);
}

// Older builds stored the dark T3 Chat palette as a separate theme. Keep
// those preferences readable while mapping them to the dark variant.
function legacyThemeMode(theme: ThemePreference): ThemeAppearance | null {
  return theme === LEGACY_T3_CHAT_DARK_THEME_ID ? "dark" : null;
}

/**
 * The palette T3 Code wears with no theme installed, captured from the app's
 * stock tokens (index.css) so a draft seeded from the default look paints the
 * pixels the user is already seeing. Alpha-bearing tokens are flattened over
 * their real backdrops (canvas, or the sidebar for its rows) because theme
 * colors are stored as opaque OKLCH tokens.
 */
const T3_CODE_LIGHT_THEME_COLORS: ThemeColors = {
  canvas: "#fcfcfc",
  surface: "#ffffff",
  surfaceRaised: "#fcfcfc",
  surfaceOverlay: "#ffffff",
  text: "#27272a",
  mutedForeground: "#71717b",
  border: "#e4e4e7",
  input: "#d4d4d8",
  secondary: "#fafafa",
  accentSurface: "#f4f4f5",
  accent: "#1b4ed8",
  messageAction: "#1b4ed8",
  messageSurface: "#f4f4f5",
  codeBackground: "#ffffff",
  sidebar: "#fafafa",
  sidebarControlSurface: "#f4f4f5",
  sidebarRowSelected: "#ffffff",
  terminalBackground: "#fcfcfc",
  error: "#fb2c36",
  warning: "#fe9a00",
};

const T3_CODE_DARK_THEME_COLORS: ThemeColors = {
  canvas: "#0a0a0a",
  surface: "#111111",
  surfaceRaised: "#141414",
  surfaceOverlay: "#191919",
  text: "#f5f5f5",
  mutedForeground: "#818181",
  border: "#191919",
  input: "#1e1e1e",
  secondary: "#141414",
  accentSurface: "#141414",
  accent: "#346bf1",
  messageAction: "#346bf1",
  messageSurface: "#141414",
  codeBackground: "#111111",
  sidebar: "#000000",
  sidebarControlSurface: "#0a0a0a",
  sidebarRowSelected: "#111111",
  terminalBackground: "#0a0a0a",
  error: "#fb414a",
  warning: "#fe9a00",
};

/**
 * The standard T3 Code look as a theme palette, for seeding a new theme when
 * no theme is installed. Distinct from {@link getDefaultThemeColors}, which
 * carries the flagship T3 Chat palette used to fill roles omitted by theme
 * files.
 */
export function getStandardThemeColors(appearance: ThemeAppearance): ThemeColors {
  if (appearance === "dark") {
    return (standardDarkThemeColors ??= decodeThemeColors(T3_CODE_DARK_THEME_COLORS));
  }
  return (standardLightThemeColors ??= decodeThemeColors(T3_CODE_LIGHT_THEME_COLORS));
}

type ThemeRgbColor = {
  r: number;
  g: number;
  b: number;
};

type ThemeHslColor = {
  h: number;
  s: number;
  l: number;
};

type ThemeOklch = { L: number; C: number; h: number };
type ParsedThemeColor = { color: ThemeOklch; alpha: number };

let standardLightThemeColors: ThemeColors | undefined;
let standardDarkThemeColors: ThemeColors | undefined;

const THEME_LIGHT_FOREGROUND: ThemeRgbColor = { r: 255, g: 250, b: 255 };
const THEME_DARK_FOREGROUND: ThemeRgbColor = { r: 36, g: 21, b: 35 };
const THEME_WHITE_FOREGROUND: ThemeRgbColor = { r: 255, g: 255, b: 255 };
const THEME_BLACK_FOREGROUND: ThemeRgbColor = { r: 0, g: 0, b: 0 };

const convertToOklch = converter("oklch");

function parseThemeColor(value: unknown): ParsedThemeColor | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const parsed = parse(input);
  if (!parsed) return null;
  const color = convertToOklch(parsed);
  const lightness = color.l ?? 0;
  const chroma = color.c ?? 0;
  const hue = color.h ?? 0;
  // CSS missing components behave as zero outside interpolation. Culori omits
  // a `none` alpha from its parsed object, so distinguish it from omitted alpha.
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

function formatOklchThemeColor(color: ThemeOklch, alpha = 1): string {
  const normalizedHue = color.C < 0.0000005 ? 0 : ((color.h % 360) + 360) % 360;
  const body = `${formatThemeColorNumber(color.L, 6)} ${formatThemeColorNumber(color.C, 6)} ${formatThemeColorNumber(normalizedHue, 3)}`;
  return alpha < 1 ? `oklch(${body} / ${formatThemeColorNumber(alpha, 4)})` : `oklch(${body})`;
}

/**
 * Decode a literal CSS color into the runtime's canonical OKLCH form. Stored
 * values use this path in memory without mutating localStorage.
 */
export function toCanonicalThemeColor(value: unknown): string | null {
  const parsed = parseThemeColor(value);
  return parsed ? formatOklchThemeColor(parsed.color, parsed.alpha) : null;
}

/** Convert a runtime theme color for hex-only editor and import adapters. */
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

function themeRgbToHexColor(color: ThemeRgbColor): string {
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

function canonicalizeThemeDefinition(theme: ThemeDefinition): ThemeDefinition {
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

// ---------------------------------------------------------------------------
// Vivid palette engine: perceptual (OKLCH) derivation for user-created themes.

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

/** Find the greatest chroma along the same lightness and hue that fits in sRGB. */
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

/** Convert to sRGB after applying the palette engine's gamut mapping. */
function themeOklchToRgb(color: ThemeOklch): ThemeRgbColor {
  const linear = oklchToRgbUnclamped(mapThemeOklchToSrgbGamut(color));
  return {
    r: linearChannelToSrgb(linear.r),
    g: linearChannelToSrgb(linear.g),
    b: linearChannelToSrgb(linear.b),
  };
}

function themeOklchToThemeColor(color: ThemeOklch): string {
  return formatOklchThemeColor(mapThemeOklchToSrgbGamut(color));
}

/** Binary-search the lightness that reaches the contrast target against a background. */
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
    const contrast = themeContrastRatio(themeOklchToRgb(candidate), against);
    if (contrast >= minContrast) {
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
 * The status colors T3 Code shows without a theme, read from the app's own
 * tokens (red-500 / amber-500 families). Generated palettes fall back to
 * these instead of the flagship theme's, so an imported or created theme
 * never inherits a brand tint on destructive buttons and warnings.
 */
const STANDARD_STATUS_COLORS = {
  light: {
    error: "#fb2c36",
    warning: "#fe9a00",
  },
  dark: {
    error: "#fb414a",
    warning: "#fe9a00",
  },
} as const;

/** Pick standard status hues for the lightness of the actual canvas. */
function standardStatusColors(canvas: ThemeRgbColor): {
  error: string;
  warning: string;
} {
  // Keyed off the canvas rather than the appearance slot so an inverted theme
  // still gets signal colors tuned for the surface it actually uses.
  const appearance: ThemeAppearance = themeRelativeLuminance(canvas) < 0.179 ? "dark" : "light";
  const standard = STANDARD_STATUS_COLORS[appearance];
  return {
    error: toCanonicalThemeColor(standard.error)!,
    warning: toCanonicalThemeColor(standard.warning)!,
  };
}

/**
 * Derive the 20 source colors from two exact seeds in OKLCH. Surfaces climb a
 * perceptually even lightness ramp that carries the accent hue at low chroma,
 * and a companion action color is rotated off the accent.
 */
export function createVividThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
): ThemeColors {
  const canvasRgb = parseThemeRgbColor(
    backgroundValue,
    appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  );
  const accentRgb = parseThemeRgbColor(accentValue, { r: 168, g: 67, b: 112 });
  const canvas = themeRgbToOklch(canvasRgb);
  const accent = themeRgbToOklch(accentRgb);
  // The ramp and every contrast search follow the canvas the user actually
  // picked, not the appearance slot, so a dark canvas saved as a light theme
  // still gets light text and raised surfaces. 0.179 is the relative
  // luminance where white and black text have equal contrast headroom.
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

  // Text carries a whisper of the accent hue instead of falling back to a
  // fixed foreground, and is solved to WCAG AAA against the canvas.
  const textBase: ThemeOklch = {
    L: dark ? 0.95 : 0.2,
    C: Math.min(0.035, accent.C * 0.25),
    h: hue,
  };
  const text = solveOklchLightness(textBase, canvasRgb, 7, dark ? "lighter" : "darker");
  const textRgb = themeOklchToRgb(text);

  // The companion action rotates off the accent so a two-color theme still
  // gets the dual-voice character of the hand-tuned palettes.
  const action: ThemeOklch = {
    L: Math.min(0.85, Math.max(0.35, accent.L + (dark ? 0.06 : -0.02))),
    C: Math.max(accent.C * 0.9, 0.06),
    h: (hue + 50) % 360,
  };
  const actionRgb = themeOklchToRgb(action);

  const sidebar = surfaceAt(0.045, tintC * 1.4);
  const surface = surfaceAt(0.015);
  const surfaceRaised = surfaceAt(0.05);
  const surfaceOverlay = surfaceAt(0.075);
  const border = surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, accent.C * 0.35));
  const input = surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, accent.C * 0.4));
  const secondary = surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, accent.C * 0.5));
  const accentSurface = surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, accent.C * 0.55));
  const messageSurface = surfaceAt(dark ? 0.16 : 0.1, Math.min(0.13, accent.C * 0.6));
  const codeBackground = surfaceAt(0.035, tintC * 0.8);

  const foregroundOn = (surfaceRgb: ThemeRgbColor): string =>
    themeOklchToThemeColor(
      solveOklchLightness(textBase, surfaceRgb, 4.6, dark ? "lighter" : "darker"),
    );
  const mutedForeground = foregroundOn(themeOklchToRgb(secondary));
  const status = standardStatusColors(canvasRgb);

  return {
    canvas: themeRgbToThemeColor(canvasRgb),
    surface: themeColor(surface),
    surfaceRaised: themeColor(surfaceRaised),
    surfaceOverlay: themeColor(surfaceOverlay),
    text: themeRgbToThemeColor(textRgb),
    mutedForeground,
    border: themeColor(border),
    input: themeColor(input),
    secondary: themeColor(secondary),
    accentSurface: themeColor(accentSurface),
    accent: themeRgbToThemeColor(accentRgb),
    messageAction: themeRgbToThemeColor(actionRgb),
    messageSurface: themeColor(messageSurface),
    codeBackground: themeColor(codeBackground),
    sidebar: themeColor(sidebar),
    sidebarControlSurface: themeColor(surfaceAt(dark ? 0.1 : 0.07, tintC * 1.5)),
    sidebarRowSelected: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, accent.C * 0.6))),
    terminalBackground: themeRgbToThemeColor(canvasRgb),
    error: status.error,
    warning: status.warning,
  };
}

function themeContrastRatio(first: ThemeRgbColor, second: ThemeRgbColor): number {
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

function readableThemeColor(
  foregroundValue: string,
  background: ThemeRgbColor,
  minimumRatio = 4.6,
): string {
  const parsedForeground = parseThemeColor(foregroundValue);
  const foreground = parsedForeground
    ? themeOklchToRgb(parsedForeground.color)
    : readableThemeForeground(background);
  const renderedForeground = parsedForeground
    ? mixThemeRgbColors(background, foreground, parsedForeground.alpha)
    : foreground;
  if (themeContrastRatio(renderedForeground, background) >= minimumRatio) {
    return toCanonicalThemeColor(foregroundValue) ?? themeRgbToThemeColor(foreground);
  }

  const direction = themeRelativeLuminance(background) < 0.179 ? "lighter" : "darker";
  const solved = themeOklchToRgb(
    solveOklchLightness(themeRgbToOklch(foreground), background, minimumRatio, direction),
  );
  return themeContrastRatio(solved, background) >= 4.5
    ? themeRgbToThemeColor(solved)
    : themeRgbToThemeColor(readableThemeForeground(background));
}

function readableThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
  amount: number,
  minimumRatio: number,
): ThemeRgbColor {
  const softened = mixThemeRgbColors(foreground, background, amount);
  if (themeContrastRatio(softened, background) >= minimumRatio) return softened;

  // Find the quietest point between the requested mix and the primary
  // foreground that still clears the contrast floor. Returning the primary
  // foreground here made secondary labels jump from slightly too dim to full
  // brightness, which is especially conspicuous in dark custom themes.
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

function managedThemeBackground(value: string, appearance: ThemeAppearance): ThemeRgbColor {
  const selected = parseThemeRgbColor(
    value,
    appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  );
  const hsl = themeRgbToHsl(selected);
  return themeHslToRgb({
    h: hsl.h,
    // A background tint should support the selected mode, not turn the whole
    // app into a high-saturation surface.
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
    const lightness =
      lightnessRange[0] + ((lightnessRange[1] - lightnessRange[0]) * index) / (61 - 1);
    const color = themeHslToRgb({ h: hsl.h, s: saturation, l: lightness });
    return { color, lightness, contrast: themeContrastRatio(color, background) };
  });
  // Leave a little room for browser color conversion at render time.
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

/**
 * Creates the guided palette used by the basic theme editor. The two user
 * colors control the mood, while dependent roles are generated together so
 * text, surfaces, message actions, code, and terminal UI stay coherent.
 */
export function createManagedThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
  options?: {
    /** Use the seeds exactly as given instead of nudging them into the
     * readability envelope. Derived foregrounds still adapt for contrast. */
    exactSeeds?: boolean;
  },
): ThemeColors {
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
  const sidebar = mixThemeRgbColors(canvas, accent, 0.08);
  const surfaceRaised = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.12 : 0.035);
  const surfaceOverlay = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.18 : 0.06);
  const secondary = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.2 : 0.08);
  const mutedForeground = readableThemeText(secondary, text, 1, 4.6);
  const accentSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.3 : 0.14);
  const messageSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.36 : 0.18);
  // Code and terminal are large surfaces: they keep the canvas hue instead of
  // drifting toward the foreground grey. Code sits just above the canvas —
  // a whisper of the text tint — and the terminal sits on the canvas itself.
  const codeBackground = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.06 : 0.025);
  const status = standardStatusColors(canvas);

  return {
    canvas: themeRgbToThemeColor(canvas),
    surface: themeRgbToThemeColor(canvas),
    surfaceRaised: themeRgbToThemeColor(surfaceRaised),
    surfaceOverlay: themeRgbToThemeColor(surfaceOverlay),
    text: themeRgbToThemeColor(text),
    mutedForeground: themeRgbToThemeColor(mutedForeground),
    // Borders blend through the accent before lightening so control chrome
    // carries the theme hue like the hand-tuned palettes (#5c345b, #e0d3e1)
    // instead of flattening to grey.
    border: themeRgbToThemeColor(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.22 : 0.1),
        text,
        0.1,
      ),
    ),
    input: themeRgbToThemeColor(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.3 : 0.14),
        text,
        appearance === "dark" ? 0.14 : 0.13,
      ),
    ),
    secondary: themeRgbToThemeColor(secondary),
    accentSurface: themeRgbToThemeColor(accentSurface),
    accent: themeRgbToThemeColor(accent),
    messageAction: themeRgbToThemeColor(accent),
    messageSurface: themeRgbToThemeColor(messageSurface),
    codeBackground: themeRgbToThemeColor(codeBackground),
    sidebar: themeRgbToThemeColor(sidebar),
    sidebarControlSurface: themeRgbToThemeColor(
      mixThemeRgbColors(sidebar, text, appearance === "dark" ? 0.16 : 0.08),
    ),
    sidebarRowSelected: themeRgbToThemeColor(mixThemeRgbColors(sidebar, accent, 0.24)),
    terminalBackground: themeRgbToThemeColor(canvas),
    error: status.error,
    warning: status.warning,
  };
}

/** Theme-file defaults follow the flagship palette for the requested mode. */
export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? T3_CHAT_THEME.variants!.dark! : T3_CHAT_THEME.colors;
}

/**
 * Update one Advanced-editor source color without normalizing the rest of an
 * imported or hand-tuned palette. Semantic variants are derived in CSS.
 */
export function updateThemeColorFamily(
  colors: ThemeColors,
  role: ThemeColorRole,
  value: string,
): ThemeColors {
  return { ...colors, [role]: toCanonicalThemeColor(value) ?? value };
}

const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = BUILT_IN_THEMES;

export function getThemeDefinition(theme: ThemePreference): ThemeDefinition | null {
  const themeId = themeIdFromPreference(theme);
  return (
    BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === themeId) ??
    getCustomThemes().find((definition) => definition.id === themeId) ??
    null
  );
}

/** Artwork palettes are reviewed alongside built-ins; user themes always use the pill fallback. */
export function themeAllowsSidebarArtwork(theme: ThemePreference): boolean {
  const themeId = themeIdFromPreference(theme);
  return (
    BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === themeId)?.sidebarArtwork ===
    true
  );
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

export function getThemePreferenceMode(theme: ThemePreference): ThemeAppearance | null {
  if (theme === "system") return null;
  if (theme === "light" || theme === "dark") return theme;
  const legacyMode = legacyThemeMode(theme);
  if (legacyMode) return legacyMode;
  return getThemeDefinition(theme)?.appearance ?? null;
}

export function themeIdFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "custom-theme";
}

export class ThemeLibraryStorageError extends Schema.TaggedErrorClass<ThemeLibraryStorageError>()(
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

export const isThemeLibraryStorageError = Schema.is(ThemeLibraryStorageError);

function saveCustomThemes(
  storedThemes: ReadonlyArray<unknown>,
  themes: ReadonlyArray<ThemeDefinition>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(storedThemes));
    customThemeLibrarySnapshot = { status: "ready", storedThemes, themes };
  } catch (cause) {
    throw new ThemeLibraryStorageError({
      storageKey: CUSTOM_THEMES_STORAGE_KEY,
      operation: "write",
      reason: "storage-unavailable",
      cause,
    });
  }
  notifyCustomThemeListeners();
}

function requireWritableCustomThemeLibrary(
  snapshot: CustomThemeLibrarySnapshot,
): Extract<CustomThemeLibrarySnapshot, { status: "ready" }> {
  if (snapshot.status === "unavailable") {
    throw new ThemeLibraryStorageError({
      storageKey: CUSTOM_THEMES_STORAGE_KEY,
      operation: "read",
      reason: snapshot.reason,
      ...("cause" in snapshot ? { cause: snapshot.cause } : {}),
    });
  }
  return snapshot;
}

function getWritableCustomThemeLibrary(): Extract<CustomThemeLibrarySnapshot, { status: "ready" }> {
  return requireWritableCustomThemeLibrary(getCustomThemeLibrarySnapshot());
}

function readWritableCustomThemeLibrary(): Extract<
  CustomThemeLibrarySnapshot,
  { status: "ready" }
> {
  return requireWritableCustomThemeLibrary(readCustomThemeLibrarySnapshot());
}

function storedThemeHasId(storedTheme: unknown, themeId: string): boolean {
  return isRecord(storedTheme) && storedTheme.id === themeId;
}

function storedThemeHasCollectionId(storedTheme: unknown, collectionId: string): boolean {
  return (
    isRecord(storedTheme) &&
    isRecord(storedTheme.collection) &&
    storedTheme.collection.id === collectionId
  );
}

export function installCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }
  const library = getWritableCustomThemeLibrary();
  if (
    BUILT_IN_THEME_DEFINITIONS.some((existing) => existing.id === theme.id) ||
    library.storedThemes.some((storedTheme) => storedThemeHasId(storedTheme, theme.id))
  ) {
    throw new Error(`A theme named "${theme.label}" is already installed.`);
  }
  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const themes = [...library.themes, canonicalTheme];
  saveCustomThemes([...library.storedThemes, canonicalTheme], themes);
  return canonicalTheme;
}

export function updateCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }

  const library = getWritableCustomThemeLibrary();
  const themes = library.themes;
  const themeIndex = themes.findIndex((existing) => existing.id === theme.id);
  if (themeIndex === -1) {
    throw new Error(`The theme "${theme.label}" is not installed.`);
  }

  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const nextThemes = [...themes];
  nextThemes[themeIndex] = canonicalTheme;

  const nextStoredThemes: unknown[] = [];
  let replaced = false;
  for (const storedTheme of library.storedThemes) {
    if (!storedThemeHasId(storedTheme, theme.id)) {
      nextStoredThemes.push(storedTheme);
    } else if (!replaced) {
      nextStoredThemes.push(canonicalTheme);
      replaced = true;
    }
  }
  saveCustomThemes(nextStoredThemes, nextThemes);
  return canonicalTheme;
}

export function replaceCustomThemeCollection(
  collectionId: string,
  themes: ReadonlyArray<ThemeDefinition>,
  options?: { expectedCollection?: ReadonlyArray<ThemeDefinition> },
): ReadonlyArray<ThemeDefinition> {
  if (themes.length === 0) throw new Error("A theme collection cannot be empty.");

  const validated = themes.map((theme) => parseStoredTheme(theme));
  if (
    validated.some((theme) => theme === null || theme.collection?.id !== collectionId) ||
    new Set(validated.map((theme) => theme?.id)).size !== validated.length
  ) {
    throw new Error("That theme collection is invalid.");
  }
  const replacement = validated as ThemeDefinition[];
  const library = readWritableCustomThemeLibrary();
  const current = library.themes;
  const currentCollection = current.filter((theme) => theme.collection?.id === collectionId);
  if (
    options?.expectedCollection &&
    JSON.stringify(currentCollection) !== JSON.stringify(options.expectedCollection)
  ) {
    throw new Error("Your installed themes changed while this package was downloading. Try again.");
  }
  const occupiedIds = new Set(BUILT_IN_THEME_DEFINITIONS.map((theme) => theme.id));
  for (const storedTheme of library.storedThemes) {
    if (
      !storedThemeHasCollectionId(storedTheme, collectionId) &&
      isRecord(storedTheme) &&
      typeof storedTheme.id === "string"
    ) {
      occupiedIds.add(storedTheme.id);
    }
  }
  const conflictingTheme = replacement.find(
    (theme) => RESERVED_THEME_IDS.has(theme.id) || occupiedIds.has(theme.id),
  );
  if (conflictingTheme) {
    throw new Error(`A theme named "${conflictingTheme.label}" is already installed.`);
  }

  const nextStoredThemes: unknown[] = [];
  let insertedReplacement = false;
  for (const storedTheme of library.storedThemes) {
    if (!storedThemeHasCollectionId(storedTheme, collectionId)) {
      nextStoredThemes.push(storedTheme);
    } else if (!insertedReplacement) {
      nextStoredThemes.push(...replacement);
      insertedReplacement = true;
    }
  }
  if (!insertedReplacement) nextStoredThemes.push(...replacement);

  saveCustomThemes(nextStoredThemes, parseStoredThemes(nextStoredThemes));
  return replacement;
}

export function removeCustomTheme(themeId: string): void {
  removeCustomThemes([themeId]);
}

export function removeCustomThemes(themeIds: ReadonlyArray<string>): void {
  const removedIds = new Set(themeIds);
  if (removedIds.size === 0) return;
  const library = getWritableCustomThemeLibrary();
  const nextThemes = library.themes.filter((theme) => !removedIds.has(theme.id));
  if (nextThemes.length === library.themes.length) return;
  saveCustomThemes(
    library.storedThemes.filter(
      (storedTheme) =>
        !isRecord(storedTheme) ||
        typeof storedTheme.id !== "string" ||
        !removedIds.has(storedTheme.id),
    ),
    nextThemes,
  );
}

function parseThemeColorOverrides(value: unknown): ThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");

  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) {
      // v1 originally shipped 57 roles. Keep those files importable while new
      // themes expose only the 20 Advanced-editor source colors.
      if (LEGACY_THEME_COLOR_ROLE_SET.has(role)) continue;
      throw new Error(`"${role}" is not a supported theme color role.`);
    }
    const normalized = toCanonicalThemeColor(color);
    if (!normalized) {
      throw new Error(
        `The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`,
      );
    }
    overrides[role as ThemeColorRole] = normalized;
  }
  if (Object.keys(value).length === 0) {
    throw new Error("Add at least one color role to the theme file.");
  }
  return overrides;
}

export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) {
    throw new Error("Theme files must contain a JSON object.");
  }
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }

  const name = value.name;
  const appearance = value.appearance;
  const rawColors = value.colors;
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).");
  if (!isThemeAppearance(appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }
  if (!isRecord(rawColors)) throw new Error("Theme files need a colors object.");

  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (!isThemeId(id)) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }
  if (RESERVED_THEME_IDS.has(id)) {
    throw new Error(`The theme id "${id}" is reserved.`);
  }

  const overrides = parseThemeColorOverrides(rawColors);
  const collection = parseThemeCollection(value.collection);
  if (value.collection !== undefined && !collection) {
    throw new Error("Theme collections need a valid id and label.");
  }

  const fallback = getDefaultThemeColors(appearance);
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }
      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }
      const variantFallback = getDefaultThemeColors(variantAppearance);
      variants[variantAppearance] = {
        ...variantFallback,
        ...parseThemeColorOverrides(variantColors),
      };
    }
  }

  return {
    id,
    label: name.trim(),
    appearance,
    colors: { ...fallback, ...overrides },
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: canonicalTheme.id,
    name: canonicalTheme.label,
    appearance: canonicalTheme.appearance,
    colors: canonicalTheme.colors,
    ...(canonicalTheme.variants ? { variants: canonicalTheme.variants } : {}),
    ...(canonicalTheme.collection ? { collection: canonicalTheme.collection } : {}),
    ...(canonicalTheme.managed ? { managed: true } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ThemeSemanticColors = Readonly<{
  cardForeground: string;
  popoverForeground: string;
  primaryForeground: string;
  messageActionHover: string;
  secondaryForeground: string;
  placeholder: string;
  accentForeground: string;
  errorForeground: string;
  errorSurface: string;
  warningForeground: string;
  warningSurface: string;
  updateForeground: string;
  updateSurface: string;
  messageForeground: string;
  codeForeground: string;
  sidebarForeground: string;
  sidebarMutedForeground: string;
  terminalForeground: string;
}>;

/**
 * Expands the 20 editable colors into the readable foreground/surface pairs
 * consumed by existing UI primitives. These are derived semantic outputs,
 * not additional theme inputs or serialized schema fields.
 */
export function deriveThemeSemanticColors(colors: ThemeColors): ThemeSemanticColors {
  const canvas = parseThemeRgbColor(colors.canvas, { r: 10, g: 10, b: 10 });
  const colorOnCanvas = (value: string) => {
    const parsed = parseThemeColor(value);
    return parsed ? mixThemeRgbColors(canvas, themeOklchToRgb(parsed.color), parsed.alpha) : canvas;
  };
  const textOn = (surfaceValue: string) =>
    readableThemeColor(colors.text, colorOnCanvas(surfaceValue));
  const mutedTextOn = (surfaceValue: string) =>
    readableThemeColor(colors.mutedForeground, colorOnCanvas(surfaceValue));
  const canvasIsDark = themeRelativeLuminance(canvas) < 0.179;
  const statusSurface = (value: string) =>
    mixThemeRgbColors(canvas, colorOnCanvas(value), canvasIsDark ? 0.16 : 0.08);
  const errorSurface = statusSurface(colors.error);
  const warningSurface = statusSurface(colors.warning);
  const updateSurface = mixThemeRgbColors(
    canvas,
    colorOnCanvas(colors.accent),
    canvasIsDark ? 0.16 : 0.08,
  );
  const cardSurface = colorOnCanvas(colors.surface);
  const statusForeground = (value: string, surface: ThemeRgbColor) => {
    const cardLuminance = themeRelativeLuminance(cardSurface);
    const surfaceLuminance = themeRelativeLuminance(surface);
    const harderSurface = canvasIsDark
      ? cardLuminance > surfaceLuminance
        ? cardSurface
        : surface
      : cardLuminance < surfaceLuminance
        ? cardSurface
        : surface;
    return readableThemeColor(value, harderSurface);
  };
  const messageAction = colorOnCanvas(colors.messageAction);
  const primaryForeground = readableThemeForeground(messageAction);
  const messageActionHover = mixThemeRgbColors(
    messageAction,
    primaryForeground === THEME_LIGHT_FOREGROUND || primaryForeground === THEME_WHITE_FOREGROUND
      ? THEME_BLACK_FOREGROUND
      : THEME_WHITE_FOREGROUND,
    0.12,
  );

  return {
    cardForeground: textOn(colors.surface),
    popoverForeground: textOn(colors.surfaceOverlay),
    primaryForeground: themeRgbToThemeColor(primaryForeground),
    messageActionHover: themeRgbToThemeColor(messageActionHover),
    secondaryForeground: textOn(colors.secondary),
    placeholder: mutedTextOn(colors.surfaceRaised),
    accentForeground: textOn(colors.accentSurface),
    errorForeground: statusForeground(colors.error, errorSurface),
    errorSurface: themeRgbToThemeColor(errorSurface),
    warningForeground: statusForeground(colors.warning, warningSurface),
    warningSurface: themeRgbToThemeColor(warningSurface),
    updateForeground: statusForeground(colors.accent, updateSurface),
    updateSurface: themeRgbToThemeColor(updateSurface),
    messageForeground: textOn(colors.messageSurface),
    codeForeground: textOn(colors.codeBackground),
    sidebarForeground: textOn(colors.sidebar),
    sidebarMutedForeground: mutedTextOn(colors.sidebar),
    terminalForeground: textOn(colors.terminalBackground),
  };
}

/** One runtime input per source color in the 20-role theme schema. */
const THEME_RUNTIME_VARIABLES = {
  canvas: "--theme-canvas",
  surface: "--theme-surface",
  surfaceRaised: "--theme-surface-raised",
  surfaceOverlay: "--theme-surface-overlay",
  text: "--theme-text",
  mutedForeground: "--theme-muted-foreground",
  border: "--theme-border",
  input: "--theme-input",
  secondary: "--theme-secondary",
  accentSurface: "--theme-accent-surface",
  accent: "--theme-accent",
  messageAction: "--theme-message-action",
  messageSurface: "--theme-message-surface",
  codeBackground: "--theme-code-background",
  sidebar: "--theme-sidebar",
  sidebarControlSurface: "--theme-sidebar-control-surface",
  sidebarRowSelected: "--theme-sidebar-row-selected",
  terminalBackground: "--theme-terminal-background",
  error: "--theme-error",
  warning: "--theme-warning",
} as const satisfies Readonly<Record<ThemeColorRole, string>>;

const THEME_SEMANTIC_VARIABLES = {
  cardForeground: "--card-foreground",
  popoverForeground: "--popover-foreground",
  primaryForeground: "--primary-foreground",
  messageActionHover: "--message-action-hover",
  secondaryForeground: "--secondary-foreground",
  placeholder: "--placeholder",
  accentForeground: "--accent-foreground",
  errorForeground: "--error-foreground",
  errorSurface: "--error-surface",
  warningForeground: "--warning-foreground",
  warningSurface: "--warning-surface",
  updateForeground: "--update-foreground",
  updateSurface: "--update-surface",
  messageForeground: "--message-foreground",
  codeForeground: "--code-foreground",
  sidebarForeground: "--sidebar-foreground",
  sidebarMutedForeground: "--sidebar-muted-foreground",
  terminalForeground: "--terminal-foreground",
} as const satisfies Readonly<Record<keyof ThemeSemanticColors, string>>;

function applyThemeSemanticColors(style: CSSStyleDeclaration, colors: ThemeColors): void {
  const semanticColors = deriveThemeSemanticColors(colors);
  for (const [role, value] of Object.entries(semanticColors) as Array<
    [keyof ThemeSemanticColors, string]
  >) {
    style.setProperty(THEME_SEMANTIC_VARIABLES[role], value);
  }
}

/** Marks the document as wearing an unsaved draft rather than a stored theme. */
export const THEME_PREVIEW_ID = "__preview";

/**
 * Paint a draft palette onto the live app without installing it, so the editor
 * can be judged against the real interface instead of a miniature. Callers
 * restore the stored theme (refreshTheme) when the draft goes away.
 */
export function applyThemeColorPreview(colors: ThemeColors, appearance: ThemeAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style) return;

  // Drafts become user-controlled themes when saved, so their preview keeps
  // the fixed stage artwork hidden even when it was seeded from a built-in.
  setThemePreviewSidebarArtwork(false);
  root.dataset.themeId = THEME_PREVIEW_ID;
  root.classList.toggle("dark", appearance === "dark");
  const effectiveColors = { ...colors } as Record<ThemeColorRole, string>;
  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
    // A half-typed hex keeps the last good value instead of blanking the role.
    const variable = THEME_RUNTIME_VARIABLES[role];
    if (isThemeColor(value)) root.style.setProperty(variable, value);
    else {
      const appliedValue = root.style.getPropertyValue?.(variable);
      effectiveColors[role] = isThemeColor(appliedValue)
        ? appliedValue
        : getDefaultThemeColors(appearance)[role];
    }
  }
  applyThemeSemanticColors(root.style, effectiveColors);
}

export function applyThemePalette(theme: ThemePreference, appearance?: ThemeAppearance): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  if (!root?.style) return;

  setThemePreviewSidebarArtwork(null);
  const palette = getThemeDefinition(theme);

  if (palette) {
    root.dataset.themeId = palette.id;
    const mode = appearance ?? legacyThemeMode(theme) ?? palette.appearance;
    const colors = getThemeColorsForMode(palette, mode) ?? palette.colors;
    for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
      const variable = THEME_RUNTIME_VARIABLES[role];
      root.style.setProperty(variable, value);
    }
    applyThemeSemanticColors(root.style, colors);
    return;
  }

  delete root.dataset.themeId;
  for (const variable of Object.values(THEME_RUNTIME_VARIABLES)) {
    root.style.removeProperty(variable);
  }
  for (const variable of Object.values(THEME_SEMANTIC_VARIABLES)) {
    root.style.removeProperty(variable);
  }
}

export function resolveThemeAppearance(
  theme: ThemePreference,
  systemDark: boolean,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves?: ThemeHalves | null,
): "light" | "dark" {
  const systemAppearance = systemDark ? "dark" : "light";
  const mode = appearanceMode ?? ((followSystem ?? theme === "system") ? "system" : null);
  if (mode === "system") {
    // A configured half guarantees the appearance is renderable even when the
    // base theme lacks that mode.
    if (halves?.[systemAppearance]) return systemAppearance;
    const definition = getThemeDefinition(theme);
    return definition && getThemeColorsForMode(definition, systemAppearance) === null
      ? definition.appearance
      : systemAppearance;
  }
  if (mode === "light" || mode === "dark") {
    if (halves?.[mode]) return mode;
    const definition = getThemeDefinition(theme);
    return definition && getThemeColorsForMode(definition, mode) === null
      ? definition.appearance
      : mode;
  }
  return getThemePreferenceMode(theme) ?? "light";
}

export function resolveDesktopTheme(
  theme: ThemePreference,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves?: ThemeHalves | null,
): "light" | "dark" | "system" {
  const mode = appearanceMode ?? ((followSystem ?? theme === "system") ? "system" : null);
  if (mode === "system") {
    const definition = getThemeDefinition(theme);
    // A configured half fills in an appearance the base theme cannot render.
    const hasLightMode =
      halves?.light !== undefined ||
      (definition !== null && getThemeColorsForMode(definition, "light") !== null);
    const hasDarkMode =
      halves?.dark !== undefined ||
      (definition !== null && getThemeColorsForMode(definition, "dark") !== null);
    return definition && (!hasLightMode || !hasDarkMode) ? definition.appearance : "system";
  }
  if (mode === "light" || mode === "dark") {
    if (halves?.[mode]) return mode;
    const definition = getThemeDefinition(theme);
    return definition && getThemeColorsForMode(definition, mode) === null
      ? definition.appearance
      : mode;
  }
  return getThemePreferenceMode(theme) ?? "system";
}

export function isKnownThemePreference(theme: string): boolean {
  if (theme === "light" || theme === "dark" || theme === "system") return true;
  return getThemeDefinition(theme) !== null;
}

/**
 * An automatic-mode mix: a different theme per resolved appearance. Halves
 * only name real themes that can render their half; anything else is dropped
 * so a stale mix degrades to the base preference.
 */
export type ThemeHalves = Readonly<{ light?: string; dark?: string }>;

export function parseThemeHalves(raw: string | null): ThemeHalves | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const halves: { light?: string; dark?: string } = {};
    for (const appearance of ["light", "dark"] as const) {
      const themeId = value[appearance];
      if (typeof themeId !== "string") continue;
      const definition = getThemeDefinition(themeId);
      if (definition && getThemeColorsForMode(definition, appearance) !== null) {
        // Store the definition's id so legacy aliases resolve to the same
        // value the runtime applies to the document.
        halves[appearance] = definition.id;
      }
    }
    return halves.light !== undefined || halves.dark !== undefined ? halves : null;
  } catch {
    return null;
  }
}

/** The theme that should render the given appearance under a mix, if any. */
export function resolveThemeHalf(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
): ThemePreference {
  return halves?.[appearance] ?? theme;
}
