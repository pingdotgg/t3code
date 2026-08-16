import type { ThemeAppearance } from "./themePalettes.js";

export type ThemePreviewColors = Readonly<{
  canvas: string;
  accent: string;
  messageAction: string;
}>;

/** The standard T3 Code artwork is not a built-in theme, so its preview colors live here. */
export const STANDARD_THEME_PREVIEW_COLORS: Readonly<Record<ThemeAppearance, ThemePreviewColors>> =
  {
    light: {
      canvas: "#fcfcfc",
      accent: "#f4f4f5",
      messageAction: "#4f46e5",
    },
    dark: {
      canvas: "#0a0a0a",
      accent: "#1c1c1f",
      messageAction: "#8b9cff",
    },
  };

export type ThemePreviewRenderSpec = Readonly<{
  baseTarget: string;
  baseWeight: number;
  accent: Readonly<{
    center: readonly [x: number, y: number];
    middleOffset: number;
    middleOpacity: number;
    endOffset: number;
  }>;
  action: Readonly<{
    center: readonly [x: number, y: number];
    startOpacity: number;
    endOffset: number;
  }>;
  scale: number;
  blurAt56Px: number;
}>;

/** Shared geometry and falloff for the web and native theme preview orbs. */
export const THEME_PREVIEW_RENDER_SPECS: Readonly<Record<ThemeAppearance, ThemePreviewRenderSpec>> =
  {
    light: {
      baseTarget: "#ffffff",
      baseWeight: 0.8,
      accent: {
        center: [0.72, 0.22],
        middleOffset: 0.28,
        middleOpacity: 0.72,
        endOffset: 0.58,
      },
      action: {
        center: [0.18, 0.82],
        startOpacity: 0.45,
        endOffset: 0.55,
      },
      scale: 1.1,
      blurAt56Px: 3,
    },
    dark: {
      baseTarget: "#09090b",
      baseWeight: 0.8,
      accent: {
        center: [0.28, 0.78],
        middleOffset: 0.28,
        middleOpacity: 0.62,
        endOffset: 0.58,
      },
      action: {
        center: [0.82, 0.18],
        startOpacity: 0.45,
        endOffset: 0.55,
      },
      scale: 1.1,
      blurAt56Px: 3,
    },
  };

type Oklab = Readonly<{ l: number; a: number; b: number }>;

const OKLCH_PATTERN = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)/;
const HEX_PATTERN = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const converted = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, converted)) * 255);
}

function parseOklab(value: string): Oklab | null {
  const oklch = OKLCH_PATTERN.exec(value);
  if (oklch) {
    const lightness = Number(oklch[1]);
    const chroma = Number(oklch[2]);
    const hue = (Number(oklch[3]) * Math.PI) / 180;
    return { l: lightness, a: chroma * Math.cos(hue), b: chroma * Math.sin(hue) };
  }

  const hex = HEX_PATTERN.exec(value);
  if (!hex) return null;
  const red = srgbToLinear(Number.parseInt(hex[1]!, 16) / 255);
  const green = srgbToLinear(Number.parseInt(hex[2]!, 16) / 255);
  const blue = srgbToLinear(Number.parseInt(hex[3]!, 16) / 255);
  const lRoot = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const mRoot = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const sRoot = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return {
    l: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  };
}

function oklabToHex(color: Oklab): string {
  const lPrime = color.l + 0.3963377774 * color.a + 0.2158037573 * color.b;
  const mPrime = color.l - 0.1055613458 * color.a - 0.0638541728 * color.b;
  const sPrime = color.l - 0.0894841775 * color.a - 1.291485548 * color.b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const channels = [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function mixThemePreviewBase(colors: ThemePreviewColors, mode: ThemeAppearance): string {
  const spec = THEME_PREVIEW_RENDER_SPECS[mode]!;
  const canvas = parseOklab(colors.canvas);
  const target = parseOklab(spec.baseTarget);
  if (!canvas || !target) return colors.canvas;
  const targetWeight = 1 - spec.baseWeight;
  return oklabToHex({
    l: canvas.l * spec.baseWeight + target.l * targetWeight,
    a: canvas.a * spec.baseWeight + target.a * targetWeight,
    b: canvas.b * spec.baseWeight + target.b * targetWeight,
  });
}
