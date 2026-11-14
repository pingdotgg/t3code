// SVG line chart copied from the distilled benchmark dashboard
// (distilled-bench-dashboard/src/charts.js), without its zoom and tooltip
// wiring. One point per benchmark run, in run order.

export interface Point {
  value: number | null;
  label: string;
  branch: boolean;
  cls: string;
  title: string;
}

export interface Ref {
  value: number;
  short: string;
  label: string;
  color: string;
  kind: "exp" | "official";
}

export interface LineChartOptions {
  format: (n: number) => string;
  branchLabel: string;
  second?: { label: string; values: ReadonlyArray<number | null> };
  refs?: ReadonlyArray<Ref>;
}

const esc = (s: string | number) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

const fixed = (n: number) => n.toFixed(1);

/** Round tick step: 1, 2, 2.5 or 5 × 10^n. */
const niceStep = (span: number, count: number) => {
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
};

/** A short line sample in the same stroke style as the series it names. */
const swatch = (cls: string, color?: string) =>
  `<svg class="sw" viewBox="0 0 26 8" aria-hidden="true"><line class="${cls}" x1="1" x2="25" y1="4" y2="4"${color ? ` style="stroke:${color}"` : ""}/></svg>`;

let clipId = 0;

export const lineChart = (points: ReadonlyArray<Point>, opts: LineChartOptions) => {
  const data = points
    .map((p, i) => ({ ...p, i }))
    .filter((d): d is typeof d & { value: number } => d.value !== null && Number.isFinite(d.value));
  const W = 560;
  const H = 320;
  const left = 86;
  const right = 16;
  const top = 22;
  const bottom = 64;
  const plotW = W - left - right;
  const plotH = H - top - bottom;

  const refs = (opts.refs ?? []).filter((r) => Number.isFinite(r.value));
  const second = (opts.second?.values ?? [])
    .map((value, i) => ({ value, i }))
    .filter((d): d is { value: number; i: number } => d.value !== null && Number.isFinite(d.value));
  const values = [
    ...data.map((d) => d.value),
    ...refs.map((r) => r.value),
    ...second.map((d) => d.value),
  ];
  let lo = Math.min(0, ...values);
  let hi = Math.max(...values);
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const n = points.length;
  const colW = plotW / n;
  const x = (i: number) => left + colW * (i + 0.5);
  const y = (v: number) => top + plotH - ((v - lo) / (hi - lo)) * plotH;

  const clip = `bench-clip-${++clipId}`;
  let svg = `<svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img">`;
  svg += `<defs><clipPath id="${clip}"><rect x="${left}" y="${top - 6}" width="${plotW}" height="${plotH + 12}"/></clipPath></defs>`;

  // Shade the work branch.
  const firstBranch = points.findIndex((p) => p.branch);
  if (firstBranch !== -1) {
    const bx = left + colW * firstBranch;
    svg += `<rect class="branch-zone" x="${bx}" y="${top}" width="${left + plotW - bx}" height="${plotH}"/>`;
    svg += `<text class="zone-label" x="${bx + 6}" y="${top - 7}">${esc(opts.branchLabel)} →</text>`;
    if (firstBranch > 0)
      svg += `<text class="zone-label" x="${bx - 6}" y="${top - 7}" text-anchor="end">← before</text>`;
  }

  for (let v = lo; v <= hi + step / 2; v += step) {
    const gy = y(v);
    svg += `<line class="grid-line" x1="${left}" x2="${left + plotW}" y1="${gy}" y2="${gy}"/>`;
    svg += `<text x="${left - 8}" y="${gy + 4}" text-anchor="end">${esc(opts.format(v))}</text>`;
  }

  // Reference lines; short labels stack at the left edge so close values stay readable.
  const refCls = (r: Ref) => `ref ${r.kind === "official" ? "official" : "exp"}`;
  const placed: number[] = [];
  for (const ref of [...refs].sort((a, b) => a.value - b.value)) {
    const ry = y(ref.value);
    let ly = ry - 5;
    while (placed.some((p) => Math.abs(p - ly) < 13)) ly -= 13;
    placed.push(ly);
    svg += `<line class="${refCls(ref)}" x1="${left}" x2="${left + plotW}" y1="${ry}" y2="${ry}" style="stroke:${ref.color}"/>`;
    svg += `<text class="ref-label" x="${left + 6}" y="${ly}" style="fill:${ref.color}">${esc(ref.short)} · ${esc(opts.format(ref.value))}<title>${esc(ref.label)}</title></text>`;
  }

  if (second.length && opts.second) {
    svg += `<polyline class="series strict" clip-path="url(#${clip})" points="${second.map((d) => `${fixed(x(d.i))},${fixed(y(d.value))}`).join(" ")}"/>`;
    const s = second.at(-1)!;
    svg += `<text class="end-label strict" x="${x(s.i) - 7}" y="${y(s.value) + 16}" text-anchor="end">${esc(opts.second.label)} ${esc(opts.format(s.value))}</text>`;
  }
  svg += `<polyline class="series" clip-path="url(#${clip})" points="${data.map((d) => `${fixed(x(d.i))},${fixed(y(d.value))}`).join(" ")}"/>`;

  // Only commits that moved the number get a dot; unchanged ones are just the line.
  for (const d of data) {
    if (d.cls !== "good" && d.cls !== "bad") continue;
    svg += `<circle class="dot ${d.cls}" cx="${fixed(x(d.i))}" cy="${fixed(y(d.value))}" r="4.5"><title>${esc(`${d.title}: ${opts.format(d.value)}`)}</title></circle>`;
  }

  // Value labels on the first and last point.
  const first = data[0]!;
  const last = data.at(-1)!;
  const firstRight = x(first.i) > left + plotW * 0.6;
  if (data.length > 1)
    svg += `<text class="end-label" x="${x(first.i) + (firstRight ? -7 : 7)}" y="${y(first.value) - 8}"${firstRight ? ' text-anchor="end"' : ""}>${esc(opts.format(first.value))}</text>`;
  svg += `<text class="end-label" x="${x(last.i) - 7}" y="${y(last.value) - 10}" text-anchor="end">${esc(opts.format(last.value))}</text>`;

  // Thin the commit labels so neighbours don't overlap; the newest one always shows.
  const every = Math.max(1, Math.ceil(15 / colW));
  points.forEach((p, i) => {
    if ((n - 1 - i) % every !== 0) return;
    svg += `<text class="xlabel" transform="translate(${x(i) + 3},${top + plotH + 12}) rotate(-55)" text-anchor="end">${esc(p.label)}</text>`;
  });
  svg += `</svg>`;

  // Legend only when there is more than the one line.
  const items: string[] = [];
  if (second.length || refs.length) items.push(`<span>${swatch("series")}normal</span>`);
  if (second.length && opts.second)
    items.push(`<span>${swatch("series strict")}${esc(opts.second.label)}</span>`);
  for (const r of refs)
    items.push(`<span title="${esc(r.label)}">${swatch(refCls(r), r.color)}${esc(r.short)}</span>`);
  const legend = items.length ? `<div class="bench-legend">${items.join("")}</div>` : "";

  return { legend, svg };
};

export const fmtBytes = (n: number) => {
  const a = Math.abs(n);
  if (a < 1000) return `${Math.round(n)} B`;
  if (a < 1e6) return `${(n / 1e3).toFixed(1)} KB`;
  return `${(n / 1e6).toFixed(a < 1e7 ? 2 : 1)} MB`;
};

export const fmtUs = (n: number) => `${n.toFixed(1)} µs`;
