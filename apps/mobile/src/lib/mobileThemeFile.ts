export const MOBILE_THEME_FILE_VERSION = 1 as const;
export const MAX_MOBILE_THEME_FILE_BYTES = 64 * 1024;
export const MAX_IMPORTED_MOBILE_THEMES = 20;
export const MAX_IMPORTED_MOBILE_THEMES_BYTES = 256 * 1024;

export const PORTABLE_THEME_COLOR_ROLES = [
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

export type PortableThemeColorRole = (typeof PORTABLE_THEME_COLOR_ROLES)[number];
export type MobileThemeAppearance = "light" | "dark";
export type PortableThemeColorOverrides = Readonly<Partial<Record<PortableThemeColorRole, string>>>;

export interface ImportedMobileTheme {
  readonly version: typeof MOBILE_THEME_FILE_VERSION;
  readonly id: string;
  readonly name: string;
  readonly appearance: MobileThemeAppearance;
  readonly colors: PortableThemeColorOverrides;
  readonly variants?: Readonly<Partial<Record<MobileThemeAppearance, PortableThemeColorOverrides>>>;
  readonly collection?: Readonly<{ id: string; label: string }>;
  readonly managed?: true;
}

const PORTABLE_THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(PORTABLE_THEME_COLOR_ROLES);
const RESERVED_THEME_IDS = new Set([
  "system",
  "light",
  "dark",
  "t3-code",
  "t3-chat",
  "grove",
  "ocean",
  "ember",
  "iris",
  "t3-chat-dark",
  "t3-grove",
  "t3-ocean",
  "t3-ember",
  "t3-iris",
]);

const NAMED_COLORS: Readonly<Record<string, string>> = {
  aliceblue: "#f0f8ff",
  antiquewhite: "#faebd7",
  aqua: "#00ffff",
  aquamarine: "#7fffd4",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  bisque: "#ffe4c4",
  black: "#000000",
  blanchedalmond: "#ffebcd",
  blue: "#0000ff",
  blueviolet: "#8a2be2",
  brown: "#a52a2a",
  burlywood: "#deb887",
  cadetblue: "#5f9ea0",
  chartreuse: "#7fff00",
  chocolate: "#d2691e",
  coral: "#ff7f50",
  cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc",
  crimson: "#dc143c",
  cyan: "#00ffff",
  darkblue: "#00008b",
  darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9",
  darkgreen: "#006400",
  darkgrey: "#a9a9a9",
  darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f",
  darkorange: "#ff8c00",
  darkorchid: "#9932cc",
  darkred: "#8b0000",
  darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  darkturquoise: "#00ced1",
  darkviolet: "#9400d3",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  dimgray: "#696969",
  dimgrey: "#696969",
  dodgerblue: "#1e90ff",
  firebrick: "#b22222",
  floralwhite: "#fffaf0",
  forestgreen: "#228b22",
  fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc",
  ghostwhite: "#f8f8ff",
  gold: "#ffd700",
  goldenrod: "#daa520",
  gray: "#808080",
  green: "#008000",
  greenyellow: "#adff2f",
  grey: "#808080",
  honeydew: "#f0fff0",
  hotpink: "#ff69b4",
  indianred: "#cd5c5c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd",
  lightblue: "#add8e6",
  lightcoral: "#f08080",
  lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2",
  lightgray: "#d3d3d3",
  lightgreen: "#90ee90",
  lightgrey: "#d3d3d3",
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0",
  lime: "#00ff00",
  limegreen: "#32cd32",
  linen: "#faf0e6",
  magenta: "#ff00ff",
  maroon: "#800000",
  mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  midnightblue: "#191970",
  mintcream: "#f5fffa",
  mistyrose: "#ffe4e1",
  moccasin: "#ffe4b5",
  navajowhite: "#ffdead",
  navy: "#000080",
  oldlace: "#fdf5e6",
  olive: "#808000",
  olivedrab: "#6b8e23",
  orange: "#ffa500",
  orangered: "#ff4500",
  orchid: "#da70d6",
  palegoldenrod: "#eee8aa",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  papayawhip: "#ffefd5",
  peachpuff: "#ffdab9",
  peru: "#cd853f",
  pink: "#ffc0cb",
  plum: "#dda0dd",
  powderblue: "#b0e0e6",
  purple: "#800080",
  rebeccapurple: "#663399",
  red: "#ff0000",
  rosybrown: "#bc8f8f",
  royalblue: "#4169e1",
  saddlebrown: "#8b4513",
  salmon: "#fa8072",
  sandybrown: "#f4a460",
  seagreen: "#2e8b57",
  seashell: "#fff5ee",
  sienna: "#a0522d",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slateblue: "#6a5acd",
  slategray: "#708090",
  slategrey: "#708090",
  snow: "#fffafa",
  springgreen: "#00ff7f",
  steelblue: "#4682b4",
  tan: "#d2b48c",
  teal: "#008080",
  thistle: "#d8bfd8",
  tomato: "#ff6347",
  transparent: "#00000000",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  white: "#ffffff",
  whitesmoke: "#f5f5f5",
  yellow: "#ffff00",
  yellowgreen: "#9acd32",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeAppearance(value: unknown): value is MobileThemeAppearance {
  return value === "light" || value === "dark";
}

function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

function themeIdFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "custom-theme";
}

function parseThemeCollection(value: unknown): Readonly<{ id: string; label: string }> | undefined {
  return isRecord(value) &&
    typeof value.id === "string" &&
    /^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id) &&
    isThemeLabel(value.label)
    ? { id: value.id, label: value.label.trim() }
    : undefined;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function byteToHex(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
}

function rgbaToHex(red: number, green: number, blue: number, alpha = 1): string {
  const opaque = `#${byteToHex(red)}${byteToHex(green)}${byteToHex(blue)}`;
  return alpha >= 1 ? opaque : `${opaque}${byteToHex(alpha * 255)}`;
}

function parseCssNumber(value: string): number | null {
  const token = value.trim();
  if (!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?$/i.test(token)) return null;
  const number = Number(token);
  return Number.isFinite(number) ? number : null;
}

function parseClampedAlpha(value: string | undefined): number | null {
  if (value === undefined) return 1;
  const token = value.trim().toLowerCase();
  if (token === "") return null;
  if (token === "none") return 0;
  const percent = token.endsWith("%");
  const number = parseCssNumber(percent ? token.slice(0, -1) : token);
  if (number === null) return null;
  return Math.min(1, Math.max(0, percent ? number / 100 : number));
}

function parseScaledComponent(value: string, percentageScale: number): number | null {
  const token = value.trim().toLowerCase();
  if (token === "none") return 0;
  const percent = token.endsWith("%");
  const number = parseCssNumber(percent ? token.slice(0, -1) : token);
  if (number === null) return null;
  return percent ? (number * percentageScale) / 100 : number;
}

function parseRgbChannel(value: string): number | null {
  const token = value.trim().toLowerCase();
  if (token === "none") return 0;
  const percent = token.endsWith("%");
  const number = parseCssNumber(percent ? token.slice(0, -1) : token);
  if (number === null) return null;
  const channel = percent ? (number / 100) * 255 : number;
  return channel >= 0 && channel <= 255 ? channel : null;
}

function parseAngle(value: string): number | null {
  const token = value.trim().toLowerCase();
  const unit = token.match(/(turn|grad|rad|deg)$/)?.[1];
  const number = parseCssNumber(unit ? token.slice(0, -unit.length) : token);
  if (number === null) return null;
  if (unit === "turn") return number * 360;
  if (unit === "grad") return number * 0.9;
  if (unit === "rad") return (number * 180) / Math.PI;
  if (unit === "deg" || unit === undefined) return number;
  return null;
}

function splitFunctionalColor(value: string): {
  readonly channels: ReadonlyArray<string>;
  readonly alpha: string | undefined;
} | null {
  const slashParts = value.split("/");
  if (slashParts.length > 2) return null;
  const body = slashParts[0]?.trim() ?? "";
  const commaSeparated = body.includes(",");
  const channels = commaSeparated
    ? body.split(",").map((part) => part.trim())
    : body.split(/\s+/).filter(Boolean);
  let alpha: string | undefined = slashParts[1]?.trim();
  if (commaSeparated && channels.length === 4 && alpha === undefined) {
    alpha = channels.pop();
  }
  return { channels, alpha };
}

function splitModernFunctionalColor(value: string): {
  readonly channels: ReadonlyArray<string>;
  readonly alpha: string | undefined;
} | null {
  if (value.includes(",")) return null;
  return splitFunctionalColor(value);
}

function parseRgbColor(body: string): string | null {
  const parsed = splitFunctionalColor(body);
  if (!parsed || parsed.channels.length !== 3) return null;
  const channels = parsed.channels.map(parseRgbChannel);
  const alpha = parseClampedAlpha(parsed.alpha);
  return channels.every((channel): channel is number => channel !== null) && alpha !== null
    ? rgbaToHex(channels[0], channels[1], channels[2], alpha)
    : null;
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = h / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] =
    section < 1
      ? [chroma, secondary, 0]
      : section < 2
        ? [secondary, chroma, 0]
        : section < 3
          ? [0, chroma, secondary]
          : section < 4
            ? [0, secondary, chroma]
            : section < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  return [(red + match) * 255, (green + match) * 255, (blue + match) * 255];
}

function parsePercentage(value: string): number | null {
  const token = value.trim();
  if (!token.endsWith("%")) return null;
  const number = parseCssNumber(token.slice(0, -1));
  return number !== null && number >= 0 && number <= 100 ? number / 100 : null;
}

function parseHslColor(body: string): string | null {
  const parsed = splitFunctionalColor(body);
  if (!parsed || parsed.channels.length !== 3) return null;
  const hue = parsed.channels[0].trim() === "none" ? 0 : parseAngle(parsed.channels[0]);
  const saturation = parsed.channels[1].trim() === "none" ? 0 : parsePercentage(parsed.channels[1]);
  const lightness = parsed.channels[2].trim() === "none" ? 0 : parsePercentage(parsed.channels[2]);
  const alpha = parseClampedAlpha(parsed.alpha);
  if (hue === null || saturation === null || lightness === null || alpha === null) return null;
  const [red, green, blue] = hslToRgb(hue, saturation, lightness);
  return rgbaToHex(red, green, blue, alpha);
}

type OklchColor = Readonly<{ lightness: number; chroma: number; hue: number }>;
type EncodedRgb = readonly [red: number, green: number, blue: number];
type LinearRgb = readonly [red: number, green: number, blue: number];
const OKLCH_GAMUT_EPSILON = 0.000001;

// Mirrors web's Culori -> canonical OKLCH -> sRGB-gamut-mapped hex path locally for React Native.
function encodedSrgbChannelToLinear(channel: number): number {
  const absolute = Math.abs(channel);
  if (absolute <= 0.04045) return channel / 12.92;
  return (Math.sign(channel) || 1) * ((absolute + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(channel: number): number {
  const value = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, value)) * 255;
}

function linearSrgbToOklch([red, green, blue]: LinearRgb): OklchColor {
  const l = Math.cbrt(
    0.412221469470763 * red + 0.5363325372617348 * green + 0.0514459932675022 * blue,
  );
  const m = Math.cbrt(
    0.2119034958178252 * red + 0.6806995506452344 * green + 0.1073969535369406 * blue,
  );
  const s = Math.cbrt(
    0.0883024591900564 * red + 0.2817188391361215 * green + 0.6299787016738222 * blue,
  );
  const lightness = 0.210454268309314 * l + 0.7936177747023054 * m - 0.0040720430116193 * s;
  const a = 1.9779985324311684 * l - 2.4285922420485799 * m + 0.450593709617411 * s;
  const b = 0.0259040424655478 * l + 0.7827717124575296 * m - 0.8086757549230774 * s;
  return { lightness, chroma: Math.hypot(a, b), hue: (Math.atan2(b, a) * 180) / Math.PI };
}

function oklabToOklch(lightness: number, a: number, b: number): OklchColor {
  return {
    lightness,
    chroma: Math.hypot(a, b),
    hue: (Math.atan2(b, a) * 180) / Math.PI,
  };
}

function oklchToLinearSrgb({ lightness, chroma, hue }: OklchColor): LinearRgb {
  const hueRadians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function canonicalColorNumber(value: number, precision: number): number {
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value;
  return Number(rounded.toFixed(precision));
}

function canonicalizeOklch(color: OklchColor): OklchColor {
  const lightness = Math.min(1, Math.max(0, color.lightness));
  const chroma = Math.max(0, color.chroma);
  const hue = chroma < 0.0000005 ? 0 : ((color.hue % 360) + 360) % 360;
  return {
    lightness: canonicalColorNumber(lightness, 6),
    chroma: canonicalColorNumber(chroma, 6),
    hue: canonicalColorNumber(hue, 3),
  };
}

function mapOklchToSrgbGamut(color: OklchColor): OklchColor {
  const isInGamut = (chroma: number) =>
    oklchToLinearSrgb({ ...color, chroma }).every(
      (channel) => channel >= -0.0001 && channel <= 1.0001,
    );
  if (isInGamut(color.chroma)) return color;

  let low = 0;
  let high = color.chroma;
  const steps = Math.max(
    1,
    Math.ceil(Math.log2(Math.max(color.chroma, OKLCH_GAMUT_EPSILON) / OKLCH_GAMUT_EPSILON)),
  );
  for (let step = 0; step < steps; step += 1) {
    const middle = (low + high) / 2;
    if (isInGamut(middle)) low = middle;
    else high = middle;
  }
  return { ...color, chroma: low };
}

function oklchToWebHex(color: OklchColor, alpha: number): string | null {
  if (![color.lightness, color.chroma, color.hue, alpha].every(Number.isFinite)) return null;
  const canonicalColor = canonicalizeOklch(color);
  if (!Number.isFinite(canonicalColor.chroma / OKLCH_GAMUT_EPSILON)) return null;
  const canonicalAlpha = canonicalColorNumber(Math.min(1, Math.max(0, alpha)), 4);
  const [red, green, blue] = oklchToLinearSrgb(mapOklchToSrgbGamut(canonicalColor));
  return rgbaToHex(
    linearChannelToSrgb(red),
    linearChannelToSrgb(green),
    linearChannelToSrgb(blue),
    canonicalAlpha,
  );
}

function parseHwbColor(body: string): string | null {
  const parsed = splitModernFunctionalColor(body);
  if (!parsed || parsed.channels.length !== 3) return null;
  const hue = parsed.channels[0].trim() === "none" ? 0 : parseAngle(parsed.channels[0]);
  let whiteness = parseScaledComponent(parsed.channels[1], 100);
  let blackness = parseScaledComponent(parsed.channels[2], 100);
  const alpha = parseClampedAlpha(parsed.alpha);
  if (hue === null || whiteness === null || blackness === null || alpha === null) return null;
  whiteness /= 100;
  blackness /= 100;
  if (whiteness + blackness > 1) {
    const sum = whiteness + blackness;
    whiteness /= sum;
    blackness /= sum;
  }

  const normalizedHue = ((hue % 360) + 360) % 360;
  const saturation = blackness === 1 ? 1 : 1 - whiteness / (1 - blackness);
  const value = 1 - blackness;
  const secondary = Math.abs(((normalizedHue / 60) % 2) - 1);
  const sector = Math.floor(normalizedHue / 60);
  const low = value * (1 - saturation);
  const slope = value * (1 - saturation * secondary);
  const encodedRgb: EncodedRgb =
    sector === 0
      ? [value, slope, low]
      : sector === 1
        ? [slope, value, low]
        : sector === 2
          ? [low, value, slope]
          : sector === 3
            ? [low, slope, value]
            : sector === 4
              ? [slope, low, value]
              : [value, low, slope];
  const rgb: LinearRgb = [
    encodedSrgbChannelToLinear(encodedRgb[0]),
    encodedSrgbChannelToLinear(encodedRgb[1]),
    encodedSrgbChannelToLinear(encodedRgb[2]),
  ];
  return oklchToWebHex(linearSrgbToOklch(rgb), alpha);
}

function labToLinearSrgb(lightness: number, a: number, b: number): LinearRgb {
  const kappa = 29 ** 3 / 3 ** 3;
  const epsilon = 6 ** 3 / 29 ** 3;
  const transform = (value: number) =>
    value ** 3 > epsilon ? value ** 3 : (116 * value - 16) / kappa;
  const fy = (lightness + 16) / 116;
  const x = transform(a / 500 + fy) * (0.3457 / 0.3585);
  const y = transform(fy);
  const z = transform(fy - b / 200) * ((1 - 0.3457 - 0.3585) / 0.3585);
  return [
    x * 3.1341359569958707 - y * 1.6173863321612538 - z * 0.4906619460083532,
    x * -0.978795502912089 + y * 1.916254567259524 + z * 0.03344273116131949,
    x * 0.07195537988411677 - y * 0.2289768264158322 + z * 1.405386058324125,
  ];
}

function parseLabColor(body: string): string | null {
  const parsed = splitModernFunctionalColor(body);
  if (!parsed || parsed.channels.length !== 3) return null;
  const lightness = parseScaledComponent(parsed.channels[0], 100);
  const a = parseScaledComponent(parsed.channels[1], 125);
  const b = parseScaledComponent(parsed.channels[2], 125);
  const alpha = parseClampedAlpha(parsed.alpha);
  if (lightness === null || a === null || b === null || alpha === null) return null;
  return oklchToWebHex(
    linearSrgbToOklch(labToLinearSrgb(Math.min(100, Math.max(0, lightness)), a, b)),
    alpha,
  );
}

function parseLchColor(body: string): string | null {
  const parsed = splitModernFunctionalColor(body);
  if (!parsed || parsed.channels.length !== 3) return null;
  const lightness = parseScaledComponent(parsed.channels[0], 100);
  const chroma = parseScaledComponent(parsed.channels[1], 150);
  const hue = parsed.channels[2].trim() === "none" ? 0 : parseAngle(parsed.channels[2]);
  const alpha = parseClampedAlpha(parsed.alpha);
  if (lightness === null || chroma === null || hue === null || alpha === null) return null;
  const hueRadians = (hue * Math.PI) / 180;
  return oklchToWebHex(
    linearSrgbToOklch(
      labToLinearSrgb(
        Math.min(100, Math.max(0, lightness)),
        Math.max(0, chroma) * Math.cos(hueRadians),
        Math.max(0, chroma) * Math.sin(hueRadians),
      ),
    ),
    alpha,
  );
}

function parseOklabColor(body: string): string | null {
  const parsed = splitModernFunctionalColor(body);
  if (!parsed || parsed.channels.length !== 3) return null;
  const lightness = parseScaledComponent(parsed.channels[0], 1);
  const a = parseScaledComponent(parsed.channels[1], 0.4);
  const b = parseScaledComponent(parsed.channels[2], 0.4);
  const alpha = parseClampedAlpha(parsed.alpha);
  if (lightness === null || a === null || b === null || alpha === null) return null;
  return oklchToWebHex(oklabToOklch(Math.min(1, Math.max(0, lightness)), a, b), alpha);
}

function displayP3ToLinearSrgb(red: number, green: number, blue: number): LinearRgb {
  const p3Red = encodedSrgbChannelToLinear(red);
  const p3Green = encodedSrgbChannelToLinear(green);
  const p3Blue = encodedSrgbChannelToLinear(blue);
  const x = 0.486570948648216 * p3Red + 0.265667693169093 * p3Green + 0.1982172852343625 * p3Blue;
  const y = 0.2289745640697487 * p3Red + 0.6917385218365062 * p3Green + 0.079286914093745 * p3Blue;
  const z = 0.0451133818589026 * p3Green + 1.043944368900976 * p3Blue;
  return [
    x * 3.2409699419045226 - y * 1.5373831775700939 - z * 0.4986107602930034,
    x * -0.9692436362808796 + y * 1.8759675015077204 + z * 0.0415550574071756,
    x * 0.0556300796969936 - y * 0.2039769588889765 + z * 1.0569715142428784,
  ];
}

function parseColorFunction(body: string): string | null {
  const parsed = splitModernFunctionalColor(body);
  if (!parsed || parsed.channels.length !== 4) return null;
  const [profile, ...channelTokens] = parsed.channels;
  if (profile !== "display-p3" && profile !== "srgb") return null;
  const channels = channelTokens.map((channel) => parseScaledComponent(channel, 1));
  const alpha = parseClampedAlpha(parsed.alpha);
  if (!channels.every((channel): channel is number => channel !== null) || alpha === null) {
    return null;
  }
  const [red, green, blue] = channels;
  const linearRgb: LinearRgb =
    profile === "display-p3"
      ? displayP3ToLinearSrgb(red, green, blue)
      : [
          encodedSrgbChannelToLinear(red),
          encodedSrgbChannelToLinear(green),
          encodedSrgbChannelToLinear(blue),
        ];
  return oklchToWebHex(linearSrgbToOklch(linearRgb), alpha);
}

function parseOklchColor(body: string): string | null {
  const parsed = splitModernFunctionalColor(body);
  if (!parsed || parsed.channels.length !== 3) return null;
  const lightness = parseScaledComponent(parsed.channels[0], 1);
  const chroma = parseScaledComponent(parsed.channels[1], 0.4);
  const hue = parsed.channels[2].trim() === "none" ? 0 : parseAngle(parsed.channels[2]);
  const alpha = parseClampedAlpha(parsed.alpha);
  if (lightness === null || chroma === null || hue === null || alpha === null) return null;
  return oklchToWebHex(
    {
      lightness: Math.min(1, Math.max(0, lightness)),
      chroma: Math.max(0, chroma),
      hue,
    },
    alpha,
  );
}

export function normalizeMobileThemeColorLiteral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim().toLowerCase();
  const named = Object.prototype.hasOwnProperty.call(NAMED_COLORS, input)
    ? NAMED_COLORS[input]
    : undefined;
  if (named) return named;

  const hex = input.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    return hex.length <= 4
      ? `#${[...hex].map((character) => character.repeat(2)).join("")}`
      : `#${hex}`;
  }

  const functional = input.match(/^([a-z]+)\((.*)\)$/);
  if (!functional) return null;
  const [, name, body] = functional;
  if (name === "rgb" || name === "rgba") return parseRgbColor(body);
  if (name === "hsl" || name === "hsla") return parseHslColor(body);
  if (name === "hwb") return parseHwbColor(body);
  if (name === "lab") return parseLabColor(body);
  if (name === "lch") return parseLchColor(body);
  if (name === "oklab") return parseOklabColor(body);
  if (name === "oklch") return parseOklchColor(body);
  if (name === "color") return parseColorFunction(body);
  return null;
}

function parseThemeColorOverrides(value: unknown): PortableThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");

  const overrides: Partial<Record<PortableThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!PORTABLE_THEME_COLOR_ROLE_SET.has(role)) {
      throw new Error(`"${role}" is not a supported theme color role.`);
    }
    const normalized = normalizeMobileThemeColorLiteral(color);
    if (!normalized) {
      throw new Error(
        `The color "${String(color)}" for "${role}" is not supported. Mobile supports hex, named colors, rgb()/rgba(), hsl()/hsla(), hwb(), lab(), lch(), oklab(), oklch(), and color(display-p3 ...)/color(srgb ...).`,
      );
    }
    overrides[role as PortableThemeColorRole] = normalized;
  }
  if (Object.keys(overrides).length === 0) {
    throw new Error("Add at least one color role to the theme file.");
  }
  return overrides;
}

export function parseMobileThemeFile(value: unknown): ImportedMobileTheme {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  if (value.version !== MOBILE_THEME_FILE_VERSION) {
    throw new Error(
      `This theme file uses an unsupported version. Expected ${MOBILE_THEME_FILE_VERSION}.`,
    );
  }

  const name = value.name;
  const appearance = value.appearance;
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).");
  if (!isThemeAppearance(appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }
  if (!isRecord(value.colors)) throw new Error("Theme files need a colors object.");

  const derivedId = value.id === undefined ? themeIdFromName(name) : null;
  const id =
    derivedId !== null && RESERVED_THEME_IDS.has(derivedId)
      ? `${derivedId}-2`
      : (derivedId ?? value.id);
  if (!isThemeId(id)) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`);

  const colors = parseThemeColorOverrides(value.colors);
  const variants: Partial<Record<MobileThemeAppearance, PortableThemeColorOverrides>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }
      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }
      variants[variantAppearance] = parseThemeColorOverrides(variantColors);
    }
  }

  const collection = parseThemeCollection(value.collection);
  if (value.collection !== undefined && !collection) {
    throw new Error("Theme collections need a valid id and label.");
  }

  return {
    version: MOBILE_THEME_FILE_VERSION,
    id,
    name: name.trim(),
    appearance,
    colors,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export function parseMobileThemeFileJson(value: string): ImportedMobileTheme {
  if (utf8ByteLength(value) > MAX_MOBILE_THEME_FILE_BYTES) {
    throw new Error("Theme files must be 64 KB or smaller.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Theme files must contain valid JSON.");
  }
  return parseMobileThemeFile(parsed);
}

export function addImportedMobileTheme(
  current: ReadonlyArray<ImportedMobileTheme>,
  theme: ImportedMobileTheme,
): ReadonlyArray<ImportedMobileTheme> {
  if (current.some((candidate) => candidate.id === theme.id)) {
    throw new Error(`A theme named "${theme.name}" is already installed.`);
  }
  if (current.length >= MAX_IMPORTED_MOBILE_THEMES) {
    throw new Error(`Mobile supports up to ${MAX_IMPORTED_MOBILE_THEMES} imported themes.`);
  }
  const next = [...current, theme];
  if (utf8ByteLength(JSON.stringify(next)) > MAX_IMPORTED_MOBILE_THEMES_BYTES) {
    throw new Error("Imported themes may use up to 256 KB of device storage.");
  }
  return next;
}

export function sanitizeImportedMobileThemes(value: unknown): ReadonlyArray<ImportedMobileTheme> {
  if (!Array.isArray(value)) return [];
  const themes: ImportedMobileTheme[] = [];
  let libraryBytes = 2;
  for (const candidate of value) {
    if (themes.length >= MAX_IMPORTED_MOBILE_THEMES) break;
    try {
      const theme = parseMobileThemeFile(candidate);
      if (themes.some((existing) => existing.id === theme.id)) continue;
      const separatorBytes = themes.length === 0 ? 0 : 1;
      const nextLibraryBytes =
        libraryBytes + separatorBytes + utf8ByteLength(JSON.stringify(theme));
      if (nextLibraryBytes > MAX_IMPORTED_MOBILE_THEMES_BYTES) continue;
      themes.push(theme);
      libraryBytes = nextLibraryBytes;
    } catch {
      continue;
    }
  }
  return themes;
}
