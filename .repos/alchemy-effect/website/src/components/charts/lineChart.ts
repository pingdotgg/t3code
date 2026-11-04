/**
 * Server-rendered SVG line charts for docs: thin lines, ringed markers with a
 * distinct shape per series, a legend, hairline grid, and a native tooltip on
 * every point. Colours come from CSS classes (`.lc-s1`…`.lc-s3`, `.lc-text`,
 * `.lc-muted`, `.lc-grid`, `.lc-surface`), so the host page decides the theme.
 */

export interface Series {
  readonly name: string;
  readonly points: ReadonlyArray<readonly [x: number, y: number]>;
}

export interface LineChartSpec {
  readonly title: string;
  readonly x: Axis;
  readonly y: Axis;
  readonly series: ReadonlyArray<Series>;
  /** Written after a value in its label and tooltip (`min`), or nothing. */
  readonly unit: string;
  /** Written before a value (`$`). */
  readonly prefix?: string;
}

export interface Axis {
  readonly label: string;
  readonly ticks: ReadonlyArray<number>;
  readonly log?: boolean;
}

const W = 480;
const H = 320;
const M = { top: 84, right: 28, bottom: 48, left: 52 };

const fmt = (n: number) =>
  n >= 1000 ? `${n / 1000 >= 1000 ? `${n / 1_000_000}M` : `${n / 1000}k`}` : `${n}`;

const scale = (axis: Axis, from: number, to: number) => {
  const lo = axis.ticks[0]!;
  const hi = axis.ticks[axis.ticks.length - 1]!;
  const t = axis.log ? (v: number) => Math.log10(v) : (v: number) => v;
  return (v: number) => from + ((t(v) - t(lo)) / (t(hi) - t(lo))) * (to - from);
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A marker per series: circle, square, diamond. */
const marker = (i: number, x: number, y: number) => {
  const r = 4.5;
  if (i % 3 === 0) return `<circle cx="${x}" cy="${y}" r="${r}"/>`;
  if (i % 3 === 1)
    return `<rect x="${x - r + 0.5}" y="${y - r + 0.5}" width="${2 * r - 1}" height="${2 * r - 1}" rx="1"/>`;
  const d = r + 1;
  return `<path d="M${x} ${y - d}L${x + d} ${y}L${x} ${y + d}L${x - d} ${y}Z"/>`;
};

export const renderLineChart = (spec: LineChartSpec): string => {
  const sx = scale(spec.x, M.left, W - M.right);
  const sy = scale(spec.y, H - M.bottom, M.top);
  const out: Array<string> = [];
  out.push(
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title)}" xmlns="http://www.w3.org/2000/svg" class="lc">`,
    `<rect class="lc-surface" width="${W}" height="${H}" rx="8"/>`,
    `<text class="lc-text lc-title" x="${M.left - 36}" y="24">${esc(spec.title)}</text>`,
  );
  // Legend: shape and colour key, text in ink.
  let lx = M.left - 36;
  spec.series.forEach((s, i) => {
    out.push(
      `<g class="lc-s${i + 1}"><line x1="${lx}" x2="${lx + 16}" y1="46" y2="46"/>${marker(i, lx + 8, 46)}</g>`,
      `<text class="lc-muted lc-small" x="${lx + 22}" y="50">${esc(s.name)}</text>`,
    );
    lx += 22 + s.name.length * 6 + 20;
  });
  // Grid and axes.
  for (const t of spec.y.ticks) {
    const y = sy(t);
    out.push(
      `<line class="lc-grid" x1="${M.left}" x2="${W - M.right}" y1="${y}" y2="${y}"/>`,
      `<text class="lc-muted lc-small" x="${M.left - 8}" y="${y + 4}" text-anchor="end">${fmt(t)}</text>`,
    );
  }
  for (const t of spec.x.ticks) {
    out.push(
      `<text class="lc-muted lc-small" x="${sx(t)}" y="${H - M.bottom + 18}" text-anchor="middle">${fmt(t)}</text>`,
    );
  }
  out.push(
    `<text class="lc-muted lc-small" x="${(M.left + W - M.right) / 2}" y="${H - 10}" text-anchor="middle">${esc(spec.x.label)}</text>`,
    `<text class="lc-muted lc-small" x="${M.left - 36}" y="${M.top - 16}">${esc(spec.y.label)}</text>`,
  );
  // Lines, then ringed markers with tooltips, then end values that don't collide.
  const ends: Array<{ x: number; y: number; text: string }> = [];
  spec.series.forEach((s, i) => {
    const pts = s.points.map(([x, y]) => [sx(x), sy(y)] as const);
    out.push(
      `<g class="lc-s${i + 1}"><path fill="none" d="${pts.map(([x, y], j) => `${j ? "L" : "M"}${x} ${y}`).join("")}"/>`,
    );
    s.points.forEach(([x, y], j) => {
      const [px, py] = pts[j]!;
      out.push(
        `<g class="lc-pt">${marker(i, px, py)}<title>${esc(`${s.name}: ${fmt(x)} ${spec.x.label.toLowerCase()} → ${spec.prefix ?? ""}${y}${spec.unit ? ` ${spec.unit}` : ""}`)}</title></g>`,
      );
    });
    out.push(`</g>`);
    const [lastX, lastY] = s.points[s.points.length - 1]!;
    const [ex, ey] = pts[pts.length - 1]!;
    ends.push({
      x: ex,
      y: ey,
      text: `${spec.prefix ?? ""}${lastY}${spec.unit ? ` ${spec.unit}` : ""}`,
    });
    void lastX;
  });
  for (const end of ends) {
    const clash = ends.some(
      (o) => o !== end && Math.abs(o.x - end.x) < 40 && Math.abs(o.y - end.y) < 14,
    );
    if (clash) continue;
    // Near the right edge the label sits above and to the left of its point.
    const right = end.x > W - M.right - 60;
    out.push(
      `<text class="lc-text lc-small lc-label" x="${right ? end.x - 8 : end.x + 8}" y="${end.y - 10}" text-anchor="${right ? "end" : "start"}">${esc(end.text)}</text>`,
    );
  }
  out.push(`</svg>`);
  return out.join("");
};

/** Colours by role; the host maps these to its own theme. */
export const chartCss = (vars: {
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly grid: string;
  readonly series: readonly [string, string, string];
}) => `
.lc{display:block;width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.lc-surface{fill:${vars.surface}}
.lc-text{fill:${vars.text}}
.lc-muted{fill:${vars.muted}}
.lc-title{font-size:14px;font-weight:600}
.lc-small{font-size:11px}
.lc-grid{stroke:${vars.grid};stroke-width:1}
.lc-s1,.lc-s2,.lc-s3{stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.lc-s1{stroke:${vars.series[0]};fill:${vars.series[0]}}
.lc-s2{stroke:${vars.series[1]};fill:${vars.series[1]}}
.lc-s3{stroke:${vars.series[2]};fill:${vars.series[2]}}
.lc-s1 path[fill=none],.lc-s2 path[fill=none],.lc-s3 path[fill=none]{fill:none}
.lc-pt>*{stroke:${vars.surface};stroke-width:2}
.lc-label{stroke:${vars.surface};stroke-width:3;paint-order:stroke;stroke-linejoin:round}
`;
