/**
 * The lane palette for the history graph.
 *
 * `laneGraph.ts` deliberately emits a `colorIndex` rather than a colour: a pure
 * module has no business owning design tokens. This file is the other half of
 * that contract and the ONLY place a lane colour is decided.
 *
 * t3 has no chart-token scale, so the eight hues are declared here as OKLCH at
 * one lightness/chroma pair chosen to stay legible on both the light and the
 * dark background — a lane graph that needs a theme-conditional palette would
 * need a theme-conditional `colorIndex`, and the fold that produces it runs
 * nowhere near the theme.
 *
 * fork: f4 source-control panel
 */
import { LANE_COLOR_COUNT, LANE_COLOR_INDEX_NONE } from "~/lib/sourceControl/laneGraph";

/**
 * Eight hues, evenly spread and ordered so adjacent lanes never land on
 * neighbouring hues (a branch-out puts lanes n and n+1 side by side).
 */
const LANE_COLORS: ReadonlyArray<string> = [
  "oklch(0.68 0.13 220)", // cyan
  "oklch(0.64 0.16 300)", // purple
  "oklch(0.70 0.15 145)", // green
  "oklch(0.72 0.15 65)", // amber
  "oklch(0.65 0.17 25)", // red
  "oklch(0.68 0.13 260)", // indigo
  "oklch(0.72 0.13 175)", // teal
  "oklch(0.68 0.16 350)", // pink
];

/** The single-lane fallback: a graph with nothing to say says it quietly. */
export const LANE_FALLBACK_COLOR = "var(--muted-foreground)";

export function laneColor(colorIndex: number): string {
  if (colorIndex === LANE_COLOR_INDEX_NONE) {
    return LANE_FALLBACK_COLOR;
  }
  if (!Number.isInteger(colorIndex) || colorIndex < 0) {
    return LANE_FALLBACK_COLOR;
  }
  return LANE_COLORS[colorIndex % LANE_COLOR_COUNT] ?? LANE_FALLBACK_COLOR;
}

/** Geometry, kept next to the palette so the SVG and the gutter width agree. */
export const LANE_COLUMN_WIDTH = 12;
export const LANE_NODE_RADIUS = 3;
export const LANE_LINE_WIDTH = 1.5;
/**
 * fork: f4 redesign (audit §8 / M1) — was 8, which put the lane dots half a
 * gutter left of every other row in the panel. `CHANGES_GUTTER` is the one
 * inset, so lane 0's centre lands exactly on it.
 */
export const LANE_PAD_LEFT = 12;

export function laneCenterX(lane: number): number {
  return LANE_PAD_LEFT + lane * LANE_COLUMN_WIDTH;
}
