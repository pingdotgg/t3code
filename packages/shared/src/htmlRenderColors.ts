import "culori/css";
import { clampChroma, converter, formatHex, wcagContrast } from "culori/fn";

const toRgb = converter("rgb");
const toOklch = converter("oklch");

export function readableHtmlRenderColor(color: string, surface: string, minimum: number): string {
  const foreground = toRgb(color);
  const background = toRgb(surface);
  // A translucent canvas needs the host's underlying surface to determine contrast.
  if (!foreground || !background || (background.alpha ?? 1) < 1) return color;

  const alpha = Math.max(0, Math.min(1, foreground.alpha ?? 1));
  const painted = {
    mode: "rgb" as const,
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
  };
  if (wcagContrast(painted, background) >= minimum) return color;

  const base = toOklch(painted);
  const encode = (lightness: number) =>
    formatHex(clampChroma({ ...base, l: lightness }, "oklch", "rgb"));
  const original = encode(base.l);
  if (wcagContrast(original, background) >= minimum) return original;

  const lighter = wcagContrast("#ffffff", background) >= wcagContrast("#000000", background);
  let low = lighter ? base.l : 0;
  let high = lighter ? 1 : base.l;
  let result = encode(lighter ? 1 : 0);
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    const candidate = encode(mid);
    // Measure the encoded sRGB paint so rounding cannot put it below the threshold.
    if (wcagContrast(candidate, background) >= minimum) {
      result = candidate;
      if (lighter) high = mid;
      else low = mid;
    } else if (lighter) low = mid;
    else high = mid;
  }
  return result;
}
