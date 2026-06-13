/**
 * Single source of truth for Alchemy's brand mark — a Sri-Yantra-style
 * downward water triangle inscribed in a circle, with the centroid dot.
 *
 * Geometry (viewBox 24×24):
 *   - circle: cx=12, cy=12, r=9.5
 *   - apex (down) at (12, 12 + r=21.5)
 *   - top-left  at (12 - r·cos30°, 12 - r·sin30°) ≈ (3.77, 7.25)
 *   - top-right at (12 + r·cos30°, 12 - r·sin30°) ≈ (20.23, 7.25)
 *   - centroid coincides with the circle center → dot at (12, 12)
 *
 * Both the runtime Astro component and the build-time asset generators
 * (favicon, OG images) consume this module so the geometry is defined once.
 */

export const YANTRA_VIEWBOX = "0 0 24 24" as const;

/**
 * Path for the inscribed equilateral triangle (apex down). Vertices live
 * exactly on the circle (cx=12, cy=12, r=9.5):
 *
 *   apex    : (12,                  12 + r)             = (12,        21.5)
 *   top-left: (12 - r·cos30°, 12 - r·sin30°)            = (3.7728..., 7.25)
 *   top-right (12 + r·cos30°, 12 - r·sin30°)            = (20.2272..., 7.25)
 *
 * Coordinates are kept at 4 decimals so that at any rasterized size the
 * vertex never lands a sub-pixel outside the circle.
 */
export const YANTRA_TRIANGLE_PATH =
  "M12 21.5 L3.7272 7.25 L20.2728 7.25 Z" as const;

/** Brand color defaults — mirror tokens.css. */
export const YANTRA_COLORS = {
  /** Deep forest green — primary stroke. */
  stroke: "#3f5a2a",
  /** Centroid dot — same deep moss as the stroke. The runtime Astro
   * component overrides this with a CSS variable so it can flip to
   * terracotta in dark mode. */
  dot: "#3f5a2a",
  /** Parchment background (e.g. for OG cards). */
  bg: "#f5efe3",
} as const;

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
  } = opts;

  const strokeColor = useCurrentColor ? "currentColor" : stroke;
  const bgRect = bg ? `<rect width="24" height="24" fill="${bg}"/>` : "";

  // `stroke-linejoin="round"` is critical: at a 60° interior angle (equilateral
  // triangle) a mitered join projects past the geometric vertex by ~1 stroke
  // width, which makes the triangle tips visibly poke through the circle.
  // Round joins keep the rendered tip flush with the circle's outer edge.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${YANTRA_VIEWBOX}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${bgRect}<circle cx="12" cy="12" r="9.5"/><path d="${YANTRA_TRIANGLE_PATH}"/><circle cx="12" cy="12" r="1.1" fill="${dot}" stroke="none"/></svg>`;
}
