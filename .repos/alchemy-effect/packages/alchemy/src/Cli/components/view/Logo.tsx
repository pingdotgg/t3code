/** @jsxRuntime automatic */
/** @jsxImportSource @alchemy.run/sigil */
/**
 * The yantra logo, rasterized at runtime. Geometry mirrors
 * website/src/brand/yantra.ts (the brand's source of truth): a downward
 * equilateral triangle inscribed in a circle, bindu at the center. The
 * shapes are signed distance functions in the brand's 24-unit viewBox,
 * sampled at the on-screen positions of a braille dot grid (2x4 dots per
 * cell), so stroke weight scales with the logo exactly as the SVG does.
 */
import { useMemo } from "@alchemy.run/sigil/react";
import type { JSX } from "react";
import { theme } from "../../../Util/Theme.ts";
import { Box, Text } from "../ui/index.ts";

const VIEWBOX = 24;
const CENTER = 12;
const CIRCLE_R = 9.5;
const BINDU_R = 1.3;
const STROKE_W = 1.5;
// Strokes scale with the logo, but are snapped to whole braille dots so every
// line renders at an even weight, and floored so small logos never break up.
const MIN_STROKE_DOTS = 2;
// Supersamples per braille dot along each axis; a dot is raised when at least
// half of its cell is covered.
const SAMPLES = 4;
const COVERAGE_THRESHOLD = 0.5;
// Terminals space braille dots evenly within a cell, but leave extra leading
// between cells: a cell is 2 dot pitches wide and ~4.25 tall (3 pitches between
// its 4 rows, plus a 1.25-pitch gap to the next cell). Sampling at those real
// positions keeps circles round on screen instead of ~6% tall and lumpy at
// every cell seam.
const CELL_W_PITCHES = 2;
const CELL_H_PITCHES = 4.25;

type Point = readonly [number, number];

/**
 * Where each braille dot actually lands, in viewBox units, addressed by global
 * dot column `i` (0..cols*2) and dot row `j` (0..rows*4). The logo is centered
 * on the grid's midpoint, which is always a point of symmetry (a cell center or
 * the middle of an inter-cell gap), so symmetric shapes rasterize
 * symmetrically.
 */
interface DotGrid {
  cols: number;
  rows: number;
  /** viewBox units per dot pitch */
  scale: number;
  dot: (i: number, j: number) => Point;
}

const makeGrid = (cols: number): DotGrid => {
  const width = cols * CELL_W_PITCHES; // logo width in dot pitches
  const rows = Math.ceil(width / CELL_H_PITCHES);
  const scale = VIEWBOX / width;
  const offsetY = (rows * CELL_H_PITCHES - width) / 2;
  const padY = (CELL_H_PITCHES - 4) / 2;
  return {
    cols,
    rows,
    scale,
    dot: (i, j) => [
      (Math.floor(i / 2) * CELL_W_PITCHES + (i % 2) + 0.5) * scale,
      (Math.floor(j / 4) * CELL_H_PITCHES + padY + (j % 4) + 0.5 - offsetY) * scale,
    ],
  };
};

/** Per-dot coverage in [0, 1] for one shape on one grid. */
type Coverage = (i: number, j: number) => number;

/** A shape that knows how to rasterize itself onto a dot grid. */
interface Shape {
  color: string;
  compile: (grid: DotGrid) => Coverage;
}

/**
 * Supersample a signed distance field over each dot's footprint (one pitch
 * square). Best for thin diagonal strokes.
 */
const areaSampled =
  (sd: (x: number, y: number) => number) =>
  (grid: DotGrid): Coverage => {
    const step = grid.scale / SAMPLES;
    return (i, j) => {
      const [x, y] = grid.dot(i, j);
      const x0 = x - grid.scale / 2;
      const y0 = y - grid.scale / 2;
      let hits = 0;
      for (let b = 0; b < SAMPLES; b++) {
        for (let a = 0; a < SAMPLES; a++) {
          if (sd(x0 + (a + 0.5) * step, y0 + (b + 0.5) * step) <= 0) hits++;
        }
      }
      return hits / (SAMPLES * SAMPLES);
    };
  };

const sdSegment = (px: number, py: number, [ax, ay]: Point, [bx, by]: Point) => {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)));
  return Math.hypot(apx - t * abx, apy - t * aby);
};

/**
 * Pull `inner` (per-line innermost dot index, measured outward from the
 * center) toward the center until it moves at most one dot between adjacent
 * lines. Each change only thickens the stroke, and the fixpoint is
 * order-independent, so symmetry is preserved.
 */
const smoothInnerEdge = (inner: Array<number | undefined>) => {
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 0; k < inner.length; k++) {
      const q = inner[k];
      if (q === undefined) continue;
      for (const n of [inner[k - 1], inner[k + 1]]) {
        if (n !== undefined && q > n + 1) {
          inner[k] = n + 1;
          changed = true;
        }
      }
    }
  }
};

/**
 * Stroked circle outline. Rasterizing the annulus directly (by area or by dot
 * center) rounds the outer and inner edges independently, so where their
 * stair-steps fall out of phase the stroke flickers a dot thicker and thinner
 * line to line. Instead, only the outer edge is snapped to the grid and the
 * stroke is filled inward from it by a whole-dot count derived from the true
 * thickness across that row (on the sides) or column (on the caps); that count
 * changes monotonically around the circle. The inner edge is then smoothed so
 * it never jumps two dots where the outer edge and the count step together.
 */
const ring = (cx: number, cy: number, r: number, strokeW: number, color: string): Shape => ({
  color,
  compile: (grid) => {
    const W = grid.cols * 2;
    const H = grid.rows * 4;
    const ro = r + strokeW / 2;
    const ri = r - strokeW / 2;
    const at = (i: number, j: number): Point => {
      const [x, y] = grid.dot(i, j);
      return [x - cx, y - cy];
    };
    /** Outer edge and whole-dot stroke count across a chord at `offset`. */
    const chord = (offset: number) => {
      const outer = Math.sqrt(ro * ro - offset * offset);
      const inner = Math.abs(offset) < ri ? Math.sqrt(ri * ri - offset * offset) : 0;
      return { outer, count: Math.max(1, Math.round((outer - inner) / grid.scale)) };
    };
    const on = Array.from({ length: H }, () => new Uint8Array(W));

    // sides (|x| >= |y|): per dot row, dots are indexed n = 0, 1, … outward
    // from the vertical center line
    const rowEdge: Array<number | undefined> = [];
    const rowInner: Array<number | undefined> = [];
    for (let j = 0; j < H; j++) {
      const [, y] = at(0, j);
      if (Math.abs(y) >= ro) continue;
      const { outer, count } = chord(y);
      rowEdge[j] = Math.floor(outer / grid.scale - 0.5);
      rowInner[j] = rowEdge[j]! - count + 1;
    }
    // only rows whose inner edge is still on the side (past 45° the caps own
    // it) take part in smoothing, or the caps' short chords would drag it in
    const sideInner = rowInner.map((q, j) =>
      q !== undefined && (q + 0.5) * grid.scale >= Math.abs(at(0, j)[1]) ? q : undefined,
    );
    smoothInnerEdge(sideInner);
    sideInner.forEach((q, j) => q !== undefined && (rowInner[j] = q));
    for (let j = 0; j < H; j++) {
      const edge = rowEdge[j];
      if (edge === undefined) continue;
      const [, y] = at(0, j);
      for (let i = 0; i < W; i++) {
        const [x] = at(i, j);
        if (Math.abs(x) < Math.abs(y)) continue;
        const n = Math.round(Math.abs(x) / grid.scale - 0.5);
        if (n <= edge && n >= rowInner[j]!) on[j][i] = 1;
      }
    }

    // caps (|y| > |x|): per dot column, dots are indexed k = 0, 1, … inward
    // from the top. Rows are unevenly spaced (cell gaps), so walk the actual
    // dots; the bottom cap mirrors the top since the grid is symmetric.
    const colEdge: Array<number | undefined> = [];
    const colInner: Array<number | undefined> = [];
    for (let i = 0; i < W; i++) {
      const [x] = at(i, 0);
      if (Math.abs(x) >= ro) continue;
      const { outer, count } = chord(x);
      let top = 0;
      while (top < H / 2 && Math.abs(at(i, top)[1]) > outer) top++;
      colEdge[i] = top;
      colInner[i] = top + count - 1;
    }
    // smooth in "distance from center" terms, where inner edges move outward
    const half = H / 2;
    const fromCenter = colInner.map((k) => (k === undefined ? undefined : half - 1 - k));
    const capInner = fromCenter.map((q, i) =>
      q !== undefined && Math.abs(at(i, half - 1 - q)[1]) > Math.abs(at(i, 0)[0]) ? q : undefined,
    );
    smoothInnerEdge(capInner);
    capInner.forEach((q, i) => q !== undefined && (fromCenter[i] = q));
    for (let i = 0; i < W; i++) {
      const top = colEdge[i];
      if (top === undefined) continue;
      const innerK = half - 1 - fromCenter[i]!;
      const [x] = at(i, 0);
      for (let k = top; k <= innerK && k < half; k++) {
        for (const j of [k, H - 1 - k]) {
          if (Math.abs(at(i, j)[1]) > Math.abs(x)) on[j][i] = 1;
        }
      }
    }
    return (i, j) => on[j][i];
  },
});

/** Stroked closed polygon with round joins (stroke-linejoin="round"). */
const polygon = (pts: ReadonlyArray<Point>, strokeW: number, color: string): Shape => ({
  color,
  compile: areaSampled((x, y) => {
    let d = Infinity;
    for (let k = 0; k < pts.length; k++) {
      d = Math.min(d, sdSegment(x, y, pts[k], pts[(k + 1) % pts.length]));
    }
    return d - strokeW / 2;
  }),
});

/**
 * Filled circle, sampled at dot centers (area sampling leaves bumps on solid
 * fills). Some radii leave a narrow nub on the cap row or column, so the radius
 * is nudged by up to half a dot pitch to the closest one whose caps are at
 * least 40% of the widest span on both axes.
 */
const disc = (cx: number, cy: number, r: number, color: string): Shape => ({
  color,
  compile: (grid) => {
    const W = grid.cols * 2;
    const H = grid.rows * 4;
    const inside = (radius: number) => (i: number, j: number) => {
      const [x, y] = grid.dot(i, j);
      return Math.hypot(x - cx, y - cy) <= radius;
    };
    const capsOk = (radius: number) => {
      const test = inside(radius);
      const rowW = new Map<number, number>();
      const colH = new Map<number, number>();
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          if (!test(i, j)) continue;
          rowW.set(j, (rowW.get(j) ?? 0) + 1);
          colH.set(i, (colH.get(i) ?? 0) + 1);
        }
      }
      const capRatio = (spans: Map<number, number>) => {
        if (spans.size === 0) return 0;
        const keys = [...spans.keys()].sort((a, b) => a - b);
        const widest = Math.max(...spans.values());
        return Math.min(spans.get(keys[0])!, spans.get(keys[keys.length - 1])!) / widest;
      };
      return capRatio(rowW) >= 0.4 && capRatio(colH) >= 0.4;
    };
    const step = grid.scale * 0.05;
    let radius = r;
    for (let k = 0; k <= 9; k++) {
      if (capsOk(r - k * step)) {
        radius = r - k * step;
        break;
      }
      if (capsOk(r + k * step)) {
        radius = r + k * step;
        break;
      }
    }
    const test = inside(radius);
    return (i, j) => (test(i, j) ? 1 : 0);
  },
});

/**
 * The yantra, mirroring yantra.ts: the triangle's circumradius is pulled in by
 * a quarter stroke so its tips merge into the ring.
 */
const yantra = (strokeW: number): Shape[] => {
  const triR = CIRCLE_R - strokeW / 4;
  const dx = triR * Math.cos(Math.PI / 6);
  const topY = CENTER - triR * Math.sin(Math.PI / 6);
  return [
    ring(CENTER, CENTER, CIRCLE_R, strokeW, theme.color.accent),
    polygon(
      [
        [CENTER, CENTER + triR],
        [CENTER - dx, topY],
        [CENTER + dx, topY],
      ],
      strokeW,
      theme.color.accent,
    ),
    disc(CENTER, CENTER, BINDU_R, theme.color.brand),
  ];
};

// braille dot bit per (row 0-3, column 0-1) subpixel
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

interface LogoRun {
  text: string;
  color?: string;
}

const rasterizeLogo = (cols: number): LogoRun[][] => {
  const grid = makeGrid(cols);
  const strokeW = Math.max(MIN_STROKE_DOTS, Math.round(STROKE_W / grid.scale)) * grid.scale;
  const layers = yantra(strokeW).map((shape) => ({
    color: shape.color,
    coverage: shape.compile(grid),
  }));

  const lines: LogoRun[][] = [];
  for (let r = 0; r < grid.rows; r++) {
    const runs: LogoRun[] = [];
    const push = (text: string, color?: string) => {
      const last = runs[runs.length - 1];
      if (last && last.color === color) last.text += text;
      else runs.push({ text, color });
    };
    for (let c = 0; c < cols; c++) {
      let bits = 0;
      // the cell's color is whichever shape covers the most of its raised dots
      const weight = new Map<string, number>();
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          let union = 0;
          for (const layer of layers) {
            const cov = layer.coverage(c * 2 + sx, r * 4 + sy);
            if (cov === 0) continue;
            union = Math.max(union, cov);
            weight.set(layer.color, (weight.get(layer.color) ?? 0) + cov);
          }
          if (union >= COVERAGE_THRESHOLD) bits |= BRAILLE_BITS[sy][sx];
        }
      }
      if (bits === 0) push(" ");
      else {
        let color: string | undefined;
        let best = 0;
        for (const [k, w] of weight) if (w > best) [color, best] = [k, w];
        push(String.fromCharCode(0x2800 + bits), color);
      }
    }
    // drop trailing whitespace runs
    while (runs.length > 0) {
      const last = runs[runs.length - 1];
      if (last.color !== undefined || last.text.trim() !== "") break;
      runs.pop();
    }
    lines.push(runs);
  }
  while (lines.length > 0 && lines[0].length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
};

// Braille rasterization is mojibake on non-Unicode terminals — the help
// formatter skips mounting the logo entirely when Unicode is unavailable.
type LogoProps = { cols: number };

export function Logo({ cols }: LogoProps): JSX.Element | null {
  const lines = useMemo(() => rasterizeLogo(cols), [cols]);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((runs, i) => (
        <Text key={i}>
          {runs.length === 0
            ? " "
            : runs.map((run, j) => (
                <Text key={j} color={run.color}>
                  {run.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
