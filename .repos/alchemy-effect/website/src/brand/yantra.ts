/**
 * Single source of truth for Alchemy's brand mark — a Sri-Yantra-style
 * downward water triangle inscribed in a circle, with the centroid dot.
 *
 * Both the runtime Astro component and the build-time asset generators
 * (favicon, OG images) consume this module so the geometry is defined once.
 */

const YANTRA = {
  viewBox: [0, 0, 24, 24],
  center: 12,
  circleRadius: 9.5,
  binduRadius: 1.1,
  strokeWidth: 1.1,
} as const;

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
function yantraTrianglePath(): string {
  const r = YANTRA.circleRadius - YANTRA.strokeWidth / 4;
  const round = (n: number) => Number(n.toFixed(4));
  const dx = round(r * Math.cos(Math.PI / 6));
  const topY = round(YANTRA.center - r * Math.sin(Math.PI / 6));
  const apexY = round(YANTRA.center + r);
  return `M${YANTRA.center} ${apexY} L${YANTRA.center - dx} ${topY} L${YANTRA.center + dx} ${topY} Z`;
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

export type YantraTheme = keyof typeof YANTRA_THEMES;

export interface YantraOptions {
  /** Pixel size of the rendered SVG (square). Default 24. */
  size?: number;
  /** Brand palette. Default light; `auto` follows theme tokens in inline SVG. */
  theme?: YantraTheme | "auto";
  /** Output format. `svg` for inline SVG, `url` for data URL. Default `svg`. */
  output?: "svg" | "url";
}

export function yantraSvg({
  size = 24,
  theme = "light",
  output = "svg",
}: YantraOptions = {}): string {
  const colors = YANTRA_THEMES[theme === "auto" ? "light" : theme];

  const stroke =
    theme === "auto"
      ? `var(--alc-accent-deep, ${colors.stroke})`
      : colors.stroke;

  const dot =
    theme === "auto" ? `var(--alc-yantra-dot, ${colors.dot})` : colors.dot;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${YANTRA.viewBox.join(" ")}" fill="none" stroke="${stroke}" stroke-width="${YANTRA.strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    `<circle cx="${YANTRA.center}" cy="${YANTRA.center}" r="${YANTRA.circleRadius}"/>`,
    `<path d="${yantraTrianglePath()}"/>`,
    `<circle cx="${YANTRA.center}" cy="${YANTRA.center}" r="${YANTRA.binduRadius}" fill="${dot}" stroke="none"/>`,
    `</svg>`,
  ].join("");

  return output === "url"
    ? `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    : svg;
}
