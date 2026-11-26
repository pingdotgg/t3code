// Fork: maps any accent hex onto the nearest swatch of a Kaluwa palette, so accents chosen before
// palettes existed (a vivid green, a pure red) stop leaking full-saturation colour into the UI.
import type { KaluwaPalette, KaluwaSwatchSlot } from "./kaluwaPalette";

type Oklab = readonly [lightness: number, a: number, b: number];

function hexToOklab(hex: string): Oklab | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// The accent slot changes hue with every preset, so a subscription mapped to it would hop colour.
const CANDIDATE_SLOTS: ReadonlyArray<KaluwaSwatchSlot> = [
  "clay",
  "ochre",
  "sand",
  "moss",
  "sage",
  "lagoon",
  "steel",
  "slate",
  "dusk",
  "plum",
  "rose",
  "ash",
  "bone",
];
// Below this OKLab chroma a colour reads as grey and its hue stops meaning anything.
const NEUTRAL_CHROMA = 0.035;
// Hue is compared as the distance between unit hue directions at this chroma.
const HUE_WEIGHT = 0.2;
// Saturation above this is treated the same: every swatch is far softer than a vivid accent.
const CHROMA_CAP = 0.15;

/**
 * The swatch nearest a colour, measured in OKLab as hue, saturation and lightness separately,
 * weighted in that order. Plain OKLab distance would favour the swatch that matches lightness,
 * because every swatch is much softer than an old vivid accent; a dark red is still the red one.
 */
export function kaluwaNearestSwatchSlot(
  hex: string,
  palette: KaluwaPalette,
): KaluwaSwatchSlot | null {
  const input = hexToOklab(hex);
  if (input === null) return null;
  const [inputL, inputA, inputB] = input;
  const inputChroma = Math.hypot(inputA, inputB);
  const neutral = inputChroma < NEUTRAL_CHROMA;
  let best: KaluwaSwatchSlot | null = null;
  let bestDistance = Infinity;
  for (const slot of CANDIDATE_SLOTS) {
    const swatch = hexToOklab(palette[slot]);
    if (swatch === null) continue;
    const [swatchL, swatchA, swatchB] = swatch;
    const swatchChroma = Math.hypot(swatchA, swatchB);
    const hue =
      neutral || swatchChroma === 0
        ? 0
        : HUE_WEIGHT *
          Math.hypot(
            inputA / inputChroma - swatchA / swatchChroma,
            inputB / inputChroma - swatchB / swatchChroma,
          );
    const distance = Math.hypot(
      (inputL - swatchL) * 0.25,
      hue,
      (Math.min(inputChroma, CHROMA_CAP) - swatchChroma) * 0.5,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  }
  return best;
}
