import "culori/css";
import { clampChroma, converter, formatHex, wcagContrast, type Rgb } from "culori/fn";

const toRgb = converter("rgb");
const toOklch = converter("oklch");
const LIGHTNESS_STEPS = 200;

/** Keeps `color` unless it falls below `minimum` contrast on any of `surfaces`. */
export function readableHtmlRenderColor(
  color: string,
  surfaces: readonly string[],
  minimum: number,
): string {
  const foreground = toRgb(color);
  const backgrounds = surfaces.map((surface) => toRgb(surface));
  const opaque = backgrounds.filter(
    (background): background is Rgb => background !== undefined && (background.alpha ?? 1) >= 1,
  );
  // A translucent surface needs the host's underlying surface to determine contrast.
  if (!foreground || opaque.length === 0 || opaque.length < backgrounds.length) return color;

  const alpha = Math.max(0, Math.min(1, foreground.alpha ?? 1));
  const paintedOn = (background: Rgb): Rgb => ({
    mode: "rgb",
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
  });
  const originalContrasts = opaque.map((background) =>
    wcagContrast(paintedOn(background), background),
  );
  const originalWorst = Math.min(...originalContrasts);
  if (originalWorst >= minimum) return color;

  const base = toOklch(paintedOn(opaque[0]!));
  let nearest: string | undefined;
  let nearestDistance = Infinity;
  let strongest = color;
  let strongestWorst = originalWorst;
  // Contrast against several surfaces is not monotonic in lightness, so scan it.
  for (let step = 0; step <= LIGHTNESS_STEPS; step += 1) {
    const lightness = step / LIGHTNESS_STEPS;
    // Measure the encoded sRGB paint so rounding cannot put it below the threshold.
    const candidate = formatHex(clampChroma({ ...base, l: lightness }, "oklch", "rgb"));
    const contrasts = opaque.map((background) => wcagContrast(candidate, background));
    const worst = Math.min(...contrasts);
    const distance = Math.abs(lightness - base.l);
    if (worst >= minimum && distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
    // A fallback must not give up a surface the original color already reads on.
    const keepsSatisfied = contrasts.every(
      (contrast, index) => contrast >= minimum || originalContrasts[index]! < minimum,
    );
    if (keepsSatisfied && worst > strongestWorst) {
      strongest = candidate;
      strongestWorst = worst;
    }
  }
  return nearest ?? strongest;
}
