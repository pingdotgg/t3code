/**
 * The legibility contract for content that sits on the chat wallpaper.
 *
 * Chat text has no opaque backdrop: it renders on an arbitrary Unsplash photo
 * with only the scenery scrim (`--color-scenery-scrim`) between them. A photo
 * pixel can be anything, so the only backdrop a color can be checked against
 * is the *worst case*: the scrim composited over pure black and over pure
 * white. Whatever survives both survives every photo.
 *
 * Two layers exist on top of the wallpaper:
 *
 *   - bare — prose, links, timestamps. Backdrop is the scrim alone.
 *   - plate — the work log, subagent rows, code blocks. These stack a second
 *     translucent scrim (`--color-scenery-plate` / `--color-scenery-code`)
 *     under themselves, which bounds their backdrop far more tightly and buys
 *     back a muted tone for dense, small-type content.
 *
 * A plate is a flat translucent fill rather than a glass/blur material on
 * purpose: a material samples whatever is behind it, so it cannot promise a
 * contrast floor. A fixed alpha can, and `scenery-contrast.test.ts` proves the
 * whole palette clears WCAG AA against these worst cases.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Rgba extends Rgb {
  readonly a: number;
}

/** Nothing in a photo can be darker than black or brighter than white. */
export const PHOTO_EXTREMES: ReadonlyArray<Rgb> = [
  { r: 0, g: 0, b: 0 },
  { r: 255, g: 255, b: 255 },
];

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_PATTERN = /^rgba?\(([^)]+)\)$/i;

/** Parses the CSS color forms the theme uses: `#rgb`, `#rrggbb`, `rgb()`, `rgba()`. */
export function parseCssColor(value: string): Rgba {
  const input = value.trim();

  const hex = HEX_PATTERN.exec(input);
  if (hex) {
    const digits = hex[1]!;
    const expanded =
      digits.length === 3
        ? digits
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : digits;
    return {
      r: parseInt(expanded.slice(0, 2), 16),
      g: parseInt(expanded.slice(2, 4), 16),
      b: parseInt(expanded.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgb = RGB_PATTERN.exec(input);
  if (rgb) {
    const parts = rgb[1]!.split(/[,/]/).map((part) => Number(part.trim()));
    const [r, g, b, a] = parts;
    if (r !== undefined && g !== undefined && b !== undefined && Number.isFinite(r)) {
      return { r, g, b, a: a === undefined || !Number.isFinite(a) ? 1 : a };
    }
  }

  throw new Error(`Unsupported CSS color: ${value}`);
}

/** Source-over alpha blend in sRGB space — how the renderer composites layers. */
export function compositeOver(top: Rgba, bottom: Rgb): Rgb {
  const blend = (t: number, b: number) => Math.round(t * top.a + b * (1 - top.a));
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b) };
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.1 contrast ratio, 1–21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/**
 * Every backdrop the given translucent layers can produce over a photo:
 * `layers` are composited outermost-last (scrim first, then any plate) over
 * each photo extreme.
 */
export function sceneryBackdrops(layers: ReadonlyArray<string>): ReadonlyArray<Rgb> {
  return PHOTO_EXTREMES.map((photo) =>
    layers.reduce<Rgb>((backdrop, layer) => compositeOver(parseCssColor(layer), backdrop), photo),
  );
}

/**
 * The contrast a color is guaranteed regardless of which photo is behind it —
 * the ratio against its worst possible backdrop.
 */
export function worstCaseContrast(color: string, layers: ReadonlyArray<string>): number {
  const foreground = parseCssColor(color);
  return sceneryBackdrops(layers).reduce(
    (worst, backdrop) => Math.min(worst, contrastRatio(foreground, backdrop)),
    Number.POSITIVE_INFINITY,
  );
}
