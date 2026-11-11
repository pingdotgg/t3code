/**
 * Exact Sri Yantra construction shared by the section background patterns
 * (`scripts/generate-yantra-patterns.ts` → `public/patterns/`) and the Open
 * Graph cards (`OgCard.tsx`).
 *
 * Geometry (unit circle, y up, symmetric about the vertical axis):
 *
 * - Nine triangles: four pointing up (U1–U4), five pointing down (D1–D5).
 * - U1 and D1 are inscribed: all three corners touch the circle.
 * - Every other apex sits on another triangle's base (seven on-axis points).
 * - 24 off-axis points where three lines meet exactly (12 per half), which
 *   with the 9 on-axis points gives the canonical 33 marmas.
 * - The bindu sits at the centroid of the innermost triangle.
 *
 * The concurrency system leaves a few degrees of freedom, so the solver starts
 * from the proportions of the classic drawing and projects onto the nearest
 * exact solution (min-norm Gauss-Newton). Importing this module throws if any
 * concurrency misses by more than 1e-9.
 *
 * Reference: https://srilalithatripurasundari.wordpress.com/home/sri-chakra-or-shri-yantra/sri-yantra-drawing-procedure/method/geomentry-of-sri-yantra/
 */

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Parameters: nine horizontal levels L1 > … > L9 (each is one triangle's base)
 * followed by the half-widths of the seven non-inscribed triangles. Starting
 * values are measured from the classic drawing.
 */
const REFERENCE = [
  0.773, 0.536, 0.343, 0.215, 0.099, -0.077, -0.202, -0.464, -0.661,
  // U2, U3, U4, D2, D3, D4, D5
  0.72, 0.322, 0.459, 0.509, 0.633, 0.322, 0.227,
];

interface Triangle {
  name: string;
  /** y of the apex (on the vertical axis). */
  apex: number;
  /** y of the horizontal base. */
  base: number;
  /** Half-width of the base. */
  half: number;
}

function triangles(p: number[]): Triangle[] {
  const L = (i: number) => p[i - 1];
  const w = (i: number) => p[9 + i];
  const inscribed = (y: number) => Math.sqrt(1 - y * y);
  return [
    { name: "U1", apex: 1, base: L(7), half: inscribed(L(7)) },
    { name: "U2", apex: L(1), base: L(8), half: w(0) },
    { name: "U3", apex: L(2), base: L(6), half: w(1) },
    { name: "U4", apex: L(3), base: L(9), half: w(2) },
    { name: "D1", apex: -1, base: L(3), half: inscribed(L(3)) },
    { name: "D2", apex: L(6), base: L(1), half: w(3) },
    { name: "D3", apex: L(9), base: L(2), half: w(4) },
    { name: "D4", apex: L(8), base: L(4), half: w(5) },
    { name: "D5", apex: L(7), base: L(5), half: w(6) },
  ];
}

/** Left-half line: a triangle's base or its left side. */
type Line = { x0: number; y0: number; x1: number; y1: number };

function lines(p: number[]): Record<string, Line> {
  const out: Record<string, Line> = {};
  for (const t of triangles(p)) {
    out[`${t.name}.base`] = { x0: -t.half, y0: t.base, x1: 0, y1: t.base };
    out[`${t.name}.side`] = { x0: 0, y0: t.apex, x1: -t.half, y1: t.base };
  }
  return out;
}

/** The 12 off-axis triple points of the left half (mirrored on the right). */
const CONCURRENT: [string, string, string][] = [
  ["U1.side", "D2.side", "D3.base"],
  ["U1.side", "D3.side", "D1.base"],
  ["U2.side", "D2.side", "D1.base"],
  ["U2.side", "D4.side", "D4.base"],
  ["U3.side", "D2.side", "D4.base"],
  ["U3.side", "D5.side", "D5.base"],
  ["U4.side", "D2.side", "D5.base"],
  ["U3.side", "U3.base", "D3.side"],
  ["U4.side", "D4.side", "U3.base"],
  ["U2.side", "D1.side", "U1.base"],
  ["U4.side", "D3.side", "U1.base"],
  ["U4.side", "D1.side", "U2.base"],
];

function intersect(a: Line, b: Line): [number, number] {
  const dxa = a.x1 - a.x0;
  const dya = a.y1 - a.y0;
  const dxb = b.x1 - b.x0;
  const dyb = b.y1 - b.y0;
  const u = ((b.x0 - a.x0) * dyb - (b.y0 - a.y0) * dxb) / (dxa * dyb - dya * dxb);
  return [a.x0 + u * dxa, a.y0 + u * dya];
}

function distance(l: Line, [x, y]: [number, number]): number {
  const dx = l.x1 - l.x0;
  const dy = l.y1 - l.y0;
  return ((x - l.x0) * dy - (y - l.y0) * dx) / Math.hypot(dx, dy);
}

function residuals(p: number[]): number[] {
  const L = lines(p);
  return CONCURRENT.map(([a, b, c]) => distance(L[c], intersect(L[a], L[b])));
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Projects `start` onto the solution set, staying as close to it as possible. */
function solve(start: number[]): number[] {
  let p = [...start];
  for (let iteration = 0; iteration < 100; iteration++) {
    const r = residuals(p);
    if (Math.max(...r.map(Math.abs)) < 1e-14) break;
    const eps = 1e-7;
    const J = r.map(() => Array.from({ length: p.length }, () => 0));
    for (let c = 0; c < p.length; c++) {
      const q = [...p];
      q[c] += eps;
      const rq = residuals(q);
      for (let i = 0; i < r.length; i++) J[i][c] = (rq[i] - r[i]) / eps;
    }
    const JJt = J.map((a) => J.map((b) => a.reduce((s, v, k) => s + v * b[k], 0)));
    const y = solveLinear(JJt, r);
    p = p.map((v, c) => v - J.reduce((s, row, i) => s + row[c] * y[i], 0));
  }
  const worst = Math.max(...residuals(p).map(Math.abs));
  if (!(worst < 1e-9))
    throw new Error(`Sri Yantra construction did not converge (max miss ${worst})`);
  return p;
}

const params = solve(REFERENCE);
const TRIANGLES = triangles(params);

/** Largest concurrency miss of the solved construction. */
export const MAX_MISS = Math.max(...residuals(params).map(Math.abs));
const LINES = lines(params);

/** The 33 marmas: 24 off-axis triple points plus 9 on-axis apexes. */
export const MARMAS: [number, number][] = [
  ...CONCURRENT.flatMap(([a, b]) => {
    const [x, y] = intersect(LINES[a], LINES[b]);
    return [
      [x, y],
      [-x, y],
    ] as [number, number][];
  }),
  ...TRIANGLES.map((t) => [0, t.apex] as [number, number]),
];

/**
 * Innermost triangle: points down, bounded by the D5 base and the two D2
 * sides, with its apex at D2's apex. The bindu is its centroid.
 */
const BINDU_Y = (2 * TRIANGLES[8].base + TRIANGLES[5].apex) / 3;

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Enclosure radii and bhupura dimensions, in units of the triangle circle. */
const RINGS = {
  /** Circle the eight petals stand on. */
  lotus8: [1.04, 1.3],
  /** Circle between the lotus rings. */
  between: 1.33,
  lotus16: [1.36, 1.6],
  /** The three girdles (trivrtta). */
  girdles: [1.64, 1.67, 1.7],
  /** Outer bhupura line: half-side and T-gate, plus the inward spacing of its three lines. */
  bhupura: { half: 1.84, stem: 0.24, stemDepth: 0.1, bar: 0.4, barDepth: 0.26, spacing: 0.04 },
};

const SIZE = 1000;
const C = SIZE / 2;
const fmt = (n: number) => Number(n.toFixed(2)).toString();

interface View {
  /** Pixels per unit (triangle circle radius). */
  scale: number;
}

function point(v: View, x: number, y: number): string {
  return `${fmt(C + x * v.scale)},${fmt(C - y * v.scale)}`;
}

function circle(v: View, r: number, x = 0, y = 0, fill = false): string {
  const [px, py] = point(v, x, y).split(",");
  return `<circle cx="${px}" cy="${py}" r="${fmt(r * v.scale)}"${fill ? ` fill="currentColor" stroke="none"` : ""}/>`;
}

function trianglesSvg(v: View): string {
  return TRIANGLES.map(
    (t) =>
      `<polygon points="${point(v, 0, t.apex)} ${point(v, -t.half, t.base)} ${point(v, t.half, t.base)}"/>`,
  ).join("");
}

function polar(v: View, r: number, angle: number): string {
  // angle 0 = straight up, clockwise
  return point(v, r * Math.sin(angle), r * Math.cos(angle));
}

/**
 * Left edge of a petal in petal-local coordinates: `t` runs from the base
 * circle (0) to the tip (1), `u` is the angular offset from the petal's center
 * line in units of the petal's angular width. The edge leaves the base along
 * the wedge boundary (so neighbors touch without overlapping), swells into a
 * rounded shoulder, then curves inward to a pointed tip.
 */
const PETAL_EDGE: [number, number][] = [
  [0, -0.5],
  [0.25, -0.5],
  [0.42, -0.45],
  [0.5, -0.33],
  [0.58, -0.21],
  [0.8, -0.04],
  [1, 0],
];

/**
 * A ring of `n` petals standing on radius r0 with tips at r1. A cusp sits on
 * the vertical axis so the ring shares the triangles' mirror symmetry.
 */
function lotus(v: View, n: number, r0: number, r1: number): string {
  const step = (2 * Math.PI) / n;
  const d = r1 - r0;
  let out = "";
  for (let i = 0; i < n; i++) {
    const mid = (i + 0.5) * step;
    const at = ([t, u]: [number, number], side: 1 | -1) =>
      polar(v, r0 + t * d, mid + side * u * step);
    const left = PETAL_EDGE.map((p) => at(p, 1));
    const right = PETAL_EDGE.map((p) => at(p, -1)).reverse();
    out +=
      `<path d="M${left[0]} C${left[1]} ${left[2]} ${left[3]} C${left[4]} ${left[5]} ${left[6]}` +
      ` C${right[1]} ${right[2]} ${right[3]} C${right[4]} ${right[5]} ${right[6]}"/>`;
  }
  return out;
}

/**
 * One square line of the bhupura with a T-shaped gate on each side, offset
 * inward from the outer line by `inset` so the three lines stay parallel.
 */
function bhupuraLine(v: View, inset: number): string {
  const { half: H, stem, stemDepth, bar, barDepth } = RINGS.bhupura;
  const half = H - inset;
  const s = stem - inset;
  const b = bar - inset;
  const d1 = H + stemDepth + inset;
  const d2 = H + stemDepth + barDepth - inset;
  // top side, left to right, in (along, out) coordinates
  const side: [number, number][] = [
    [-half, half],
    [-s, half],
    [-s, d1],
    [-b, d1],
    [-b, d2],
    [b, d2],
    [b, d1],
    [s, d1],
    [s, half],
  ];
  const rotations: ((a: number, o: number) => [number, number])[] = [
    (a, o) => [a, o],
    (a, o) => [o, -a],
    (a, o) => [-a, -o],
    (a, o) => [-o, a],
  ];
  const pts = rotations.flatMap((rot) => side.map(([a, o]) => rot(a, o)));
  return `<polygon points="${pts.map(([x, y]) => point(v, x, y)).join(" ")}"/>`;
}

function bhupura(v: View): string {
  return [0, 1, 2].map((i) => bhupuraLine(v, i * RINGS.bhupura.spacing)).join("");
}

function enclosures(v: View, { lotuses = true, girdles = true } = {}): string {
  let out = circle(v, 1) + circle(v, RINGS.lotus8[0]);
  if (lotuses) {
    out += lotus(v, 8, RINGS.lotus8[0], RINGS.lotus8[1]);
    out += circle(v, RINGS.between) + circle(v, RINGS.lotus16[0]);
    out += lotus(v, 16, RINGS.lotus16[0], RINGS.lotus16[1]);
  }
  if (girdles) out += RINGS.girdles.map((r) => circle(v, r)).join("");
  return out;
}

const bindu = (v: View, r = 0.012) => circle(v, r, 0, BINDU_Y, true);

/** Outer extent of the bhupura gates, in units. */
const OUTER = RINGS.bhupura.half + RINGS.bhupura.stemDepth + RINGS.bhupura.barDepth;

export interface PatternStyle {
  /** Line and bindu color. Default black (the site uses the SVGs as masks). */
  color?: string;
  /** Stroke width in the 1000-unit viewBox. Default 1.1. */
  strokeWidth?: number;
}

const BODIES = {
  // The complete yantra: bhupura, girdles, both lotus rings, triangles, bindu.
  "yantra-1": (() => {
    const v = { scale: 490 / OUTER };
    return bhupura(v) + enclosures(v) + trianglesSvg(v) + bindu(v);
  })(),
  // Lotus rings around the triangles.
  "yantra-2": (() => {
    const v = { scale: 490 / RINGS.girdles[2] };
    return enclosures(v) + trianglesSvg(v) + bindu(v);
  })(),
  // The nine interlocking triangles alone.
  "yantra-3": (() => {
    const v = { scale: 470 };
    return circle(v, 1) + trianglesSvg(v) + bindu(v);
  })(),
  // Outer enclosures: bhupura and girdles around the triangle circle.
  "yantra-4": (() => {
    const v = { scale: 490 / OUTER };
    return bhupura(v) + enclosures(v, { lotuses: false }) + trianglesSvg(v);
  })(),
  // The lotus rings and girdles alone, around a central bindu.
  "yantra-5": (() => {
    const v = { scale: 490 / RINGS.girdles[2] };
    return enclosures(v) + circle(v, 0.02, 0, 0, true);
  })(),
  // Construction view: base chords across the circle, axis, and the 33 marmas.
  "yantra-6": (() => {
    const v = { scale: 470 };
    const levels = [...new Set(TRIANGLES.map((t) => t.base))];
    const chords = levels
      .map((y) => {
        const x = Math.sqrt(1 - y * y);
        return `<line x1="${point(v, -x, y).split(",")[0]}" y1="${point(v, -x, y).split(",")[1]}" x2="${point(v, x, y).split(",")[0]}" y2="${point(v, x, y).split(",")[1]}" stroke-dasharray="4 6"/>`;
      })
      .join("");
    const axis = `<line x1="${C}" y1="${C - 470}" x2="${C}" y2="${C + 470}" stroke-dasharray="4 6"/>`;
    const marmas = MARMAS.map(([x, y]) => circle(v, 0.018, x, y)).join("");
    return circle(v, 1) + chords + axis + trianglesSvg(v) + marmas + bindu(v);
  })(),
} satisfies Record<string, string>;

export type PatternName = keyof typeof BODIES;
export const PATTERN_NAMES = Object.keys(BODIES) as PatternName[];

/** One background pattern as a standalone 1000×1000 SVG document. */
export function sriYantraPattern(
  name: PatternName,
  { color = "#000", strokeWidth = 1.1 }: PatternStyle = {},
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" fill="none" stroke="${color}" color="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round">${BODIES[name]}</svg>\n`;
}
