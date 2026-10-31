type SrgbChannels = readonly [number, number, number];

const HEX_PATTERN = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i;
const OKLCH_PATTERN = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/;

function linearToSrgb(value: number): number {
  const converted = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, converted)) * 255);
}

function oklabToLinearSrgb(lightness: number, a: number, b: number) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ] as const;
}

function oklabToSrgb(lightness: number, a: number, b: number): SrgbChannels {
  const [red, green, blue] = oklabToLinearSrgb(lightness, a, b);
  return [linearToSrgb(red), linearToSrgb(green), linearToSrgb(blue)];
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function srgbToOklab(channels: SrgbChannels) {
  const [red = 0, green = 0, blue = 0] = channels.map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ] as const;
}

function toHex(channels: SrgbChannels): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function parseOklchThemeColor(
  value: string,
): { readonly channels: SrgbChannels; readonly alpha: number } | null {
  const match = OKLCH_PATTERN.exec(value);
  if (!match) return null;
  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = (Number(match[3]) * Math.PI) / 180;
  return {
    channels: oklabToSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue)),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** Channels for an opaque hex or OKLCH color; translucent and other formats return null. */
export function themeColorChannels(color: string): SrgbChannels | null {
  const hex = HEX_PATTERN.exec(color);
  if (hex) {
    const [, red = "0", green = "0", blue = "0"] = hex;
    return [Number.parseInt(red, 16), Number.parseInt(green, 16), Number.parseInt(blue, 16)];
  }
  const oklch = parseOklchThemeColor(color);
  return oklch && oklch.alpha >= 1 ? oklch.channels : null;
}

function relativeLuminance(channels: SrgbChannels): number {
  const [red, green, blue] = channels.map(srgbToLinear);
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

export function isDarkThemeColor(color: string): boolean {
  const channels = themeColorChannels(color);
  return channels !== null && relativeLuminance(channels) < 0.18;
}

function contrastRatio(first: SrgbChannels, second: SrgbChannels): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

export function themeColorContrastRatio(first: string, second: string): number {
  const firstChannels = themeColorChannels(first);
  const secondChannels = themeColorChannels(second);
  return firstChannels && secondChannels ? contrastRatio(firstChannels, secondChannels) : 1;
}

function contrastTarget(color: string, surface: string | ReadonlyArray<string>) {
  const channels = themeColorChannels(color);
  const surfaceChannels = (typeof surface === "string" ? [surface] : surface)
    .map(themeColorChannels)
    .filter((channels) => channels !== null);
  const minimumContrast = (candidate: SrgbChannels) =>
    Math.min(...surfaceChannels.map((surface) => contrastRatio(candidate, surface)));
  return channels && surfaceChannels.length > 0 ? { channels, minimumContrast } : null;
}

/** Returns the color unchanged when it already reads, else blends it toward black or white. */
export function themeColorWithContrast(
  accent: string,
  surface: string | ReadonlyArray<string>,
  minimum = 4.5,
): string {
  const target = contrastTarget(accent, surface);
  if (!target || target.minimumContrast(target.channels) >= minimum) return accent;

  const { channels, minimumContrast } = target;
  const black = [0, 0, 0] as const;
  const white = [255, 255, 255] as const;
  const extreme = minimumContrast(black) >= minimumContrast(white) ? black : white;
  let readable: SrgbChannels = extreme;
  let lowerAmount = 0;
  let upperAmount = 1;
  for (let index = 0; index < 12; index += 1) {
    const amount = (lowerAmount + upperAmount) / 2;
    const candidate: SrgbChannels = [
      Math.round(channels[0] + (extreme[0] - channels[0]) * amount),
      Math.round(channels[1] + (extreme[1] - channels[1]) * amount),
      Math.round(channels[2] + (extreme[2] - channels[2]) * amount),
    ];
    if (minimumContrast(candidate) >= minimum) {
      readable = candidate;
      upperAmount = amount;
    } else {
      lowerAmount = amount;
    }
  }
  return toHex(readable);
}

/**
 * Unlike `themeColorWithContrast`, which blends toward black or white and greys the color out,
 * this moves only OKLCH lightness and takes the most chroma sRGB allows at each step, so a vivid
 * accent stays vivid at the contrast it needs.
 */
export function themeAccentWithContrast(
  accent: string,
  surfaces: ReadonlyArray<string>,
  minimum = 4.5,
): string {
  const target = contrastTarget(accent, surfaces);
  if (!target || target.minimumContrast(target.channels) >= minimum) return accent;

  const { channels, minimumContrast } = target;
  const [lightness, a, b] = srgbToOklab(channels);
  const hue = Math.atan2(b, a);
  const inGamut = (linear: ReadonlyArray<number>) =>
    linear.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
  const mostVivid = (stepLightness: number) => {
    let chroma = 0;
    let lower = 0;
    let upper = Math.max(Math.hypot(a, b), 0.2);
    for (let index = 0; index < 20; index += 1) {
      const candidate = (lower + upper) / 2;
      if (
        inGamut(
          oklabToLinearSrgb(stepLightness, candidate * Math.cos(hue), candidate * Math.sin(hue)),
        )
      ) {
        chroma = candidate;
        lower = candidate;
      } else {
        upper = candidate;
      }
    }
    return oklabToSrgb(stepLightness, chroma * Math.cos(hue), chroma * Math.sin(hue));
  };

  const lighten = minimumContrast([255, 255, 255]) >= minimumContrast([0, 0, 0]);
  const step = lighten ? 0.002 : -0.002;
  for (let next = lightness; lighten ? next <= 1 : next >= 0; next += step) {
    const candidate = mostVivid(next);
    if (minimumContrast(candidate) >= minimum) return toHex(candidate);
  }
  return lighten ? "#ffffff" : "#000000";
}
