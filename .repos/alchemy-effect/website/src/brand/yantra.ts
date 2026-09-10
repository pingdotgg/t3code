/**
 * Single source of truth for Alchemy's brand mark — a Sri-Yantra-style
 * downward water triangle inscribed in a circle, with the centroid dot.
 *
 * Both the runtime Astro component and the build-time asset generators
 * (favicon, OG images) consume this module so the geometry is defined once.
 */

export const YANTRA_VIEWBOX = "0 0 24 24" as const;

/** Circle center, on both axes (viewBox 24×24). */
export const YANTRA_CENTER = 12;
/** Radius of the enclosing circle's centerline. */
export const YANTRA_CIRCLE_R = 9.5;
/** Radius of the bindu, the filled centroid dot. */
export const YANTRA_BINDU_R = 1.1;

/**
 * Path for the equilateral triangle (apex down), centered on the circle:
 *
 *   apex     : (cx,             cy + r)
 *   top-left : (cx - r·cos30°,  cy - r·sin30°)
 *   top-right: (cx + r·cos30°,  cy - r·sin30°)
 *
 * `r` is the circle's radius pulled in by a quarter stroke width. A round join
 * extends half a stroke width past the vertex, so this lands each tip's outer
 * edge midway between the ring's centerline and its outer edge: far enough in
 * that the tips don't bulge the ring's silhouette, but still deep enough into
 * the band that the corners read as merged rather than butted up against it.
 * (A half-width inset stops the tips at the centerline, which opens a visible
 * notch at each corner.) The triangle's centroid stays at the circle center
 * regardless, so the bindu is shared.
 *
 * Derived rather than transcribed, so the coordinates cannot drift from the
 * formulas above. Rounded to 4 decimals — well under a pixel at any size we
 * rasterize.
 */
export function yantraTrianglePath(strokeWidth: number): string {
  const r = YANTRA_CIRCLE_R - strokeWidth / 4;
  const round = (n: number) => Number(n.toFixed(4));
  const dx = round(r * Math.cos(Math.PI / 6));
  const topY = round(YANTRA_CENTER - r * Math.sin(Math.PI / 6));
  const apexY = round(YANTRA_CENTER + r);
  return `M${YANTRA_CENTER} ${apexY} L${YANTRA_CENTER - dx} ${topY} L${YANTRA_CENTER + dx} ${topY} Z`;
}

/**
 * Brand palette, one entry per theme — mirrors tokens.css. Every rendering of
 * the mark is painted from one of these two entries, so the favicons, app
 * icons, OG cards and README hero can't drift apart.
 */
export const YANTRA_THEMES = {
  light: {
    /** `--alc-accent-deep` */
    stroke: "#3f5a2a",
    /** `--alc-terracotta-deep`, mirrored by `--alc-yantra-dot` */
    dot: "#9a4f27",
    /** `--alc-bg`. Only used where an asset must be opaque. */
    bg: "#f5efe3",
  },
  dark: {
    /** `--alc-accent-deep` (dark block) */
    stroke: "#a3c473",
    /** `--alc-terracotta` (dark block), mirrored by `--alc-yantra-dot` */
    dot: "#d8835a",
    /** `--alc-bg` (dark block) */
    bg: "#14110d",
  },
} as const;

/** The two themes every brand asset is generated for. */
export type YantraTheme = keyof typeof YANTRA_THEMES;

/** Flat light-theme alias — the values `yantraSvg` falls back to. */
export const YANTRA_COLORS = YANTRA_THEMES.light;

export interface YantraOptions {
  /** Pixel size of the rendered SVG (square). Default 24. */
  size?: number;
  /** Stroke color for the circle + triangle. Default deep forest. */
  stroke?: string;
  /** Centroid dot fill. Default deep forest. */
  dot?: string;
  /**
   * Optional background color for the enclosing rect — useful for
   * favicons and OG images. When omitted, the SVG is transparent.
   */
  bg?: string;
  /**
   * Stroke width (in viewBox units, 24×24). Default 1.
   * Bump for small favicons (e.g. 1.4 at 16px) so the lines stay legible.
   */
  strokeWidth?: number;
  /**
   * If true, applies `currentColor` for the stroke instead of an explicit
   * color so the icon adopts the surrounding text color. Used by the
   * inline Astro component on the homepage.
   */
  useCurrentColor?: boolean;
  /**
   * Crops N viewBox units off each edge, so the same geometry renders larger
   * inside the frame. The glyph's visual extent is `r (9.5) + strokeWidth/2`,
   * so an inset of `2.5 - strokeWidth/2` sits exactly flush with the edge.
   * Default 0.
   */
  inset?: number;
}

/**
 * Returns a complete, standalone SVG string for the brand mark.
 * Safe for both raster pipelines (resvg, satori) and direct embedding.
 */
export function yantraSvg(opts: YantraOptions = {}): string {
  const {
    size = 24,
    stroke = YANTRA_COLORS.stroke,
    dot = YANTRA_COLORS.dot,
    bg,
    strokeWidth = 1,
    useCurrentColor = false,
    inset = 0,
  } = opts;

  const strokeColor = useCurrentColor ? "currentColor" : stroke;
  // The bg rect stays at the full 24×24 so it still covers a cropped viewBox.
  const bgRect = bg
    ? `<rect width="24" height="24" fill="${bg}" stroke="none"/>`
    : "";
  const viewBox =
    inset === 0
      ? YANTRA_VIEWBOX
      : `${inset} ${inset} ${24 - inset * 2} ${24 - inset * 2}`;

  // `stroke-linejoin="round"` is critical: at a 60° interior angle (equilateral
  // triangle) a mitered join projects past the geometric vertex by ~1 stroke
  // width, which makes the triangle tips visibly poke through the circle. A
  // round join extends only half a stroke width, which is what the triangle's
  // inset in `yantraTrianglePath` is sized against.
  const c = YANTRA_CENTER;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${bgRect}<circle cx="${c}" cy="${c}" r="${YANTRA_CIRCLE_R}"/><path d="${yantraTrianglePath(strokeWidth)}"/><circle cx="${c}" cy="${c}" r="${YANTRA_BINDU_R}" fill="${dot}" stroke="none"/></svg>`;
}
