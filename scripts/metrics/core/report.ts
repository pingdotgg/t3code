// The pure half the benchmarks share: summary statistics, how two series of runs compare, the
// noise floors A/A runs suggest, and what the machine was doing while they ran.
import * as Schema from "effect/Schema";

export const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

const sorted = (values: ReadonlyArray<number>) => values.toSorted((a, b) => a - b);

/** Nearest-rank percentile, so p90 of few samples is a value that was measured. */
export function percentile(values: ReadonlyArray<number>, p: number) {
  if (values.length === 0) return null;
  const ordered = sorted(values);
  return ordered[
    Math.min(ordered.length - 1, Math.max(0, Math.ceil((p / 100) * ordered.length) - 1))
  ]!;
}
export function median(values: ReadonlyArray<number>) {
  if (values.length === 0) return null;
  const ordered = sorted(values);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/** Least-squares slope of y over x; 0 with fewer than two distinct x. */
export function slope(points: ReadonlyArray<readonly [number, number]>) {
  if (points.length < 2) return 0;
  const mx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const my = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const sxx = points.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
  if (sxx === 0) return 0;
  return points.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / sxx;
}

/** `median` without the null, for resamples, which are never empty. */
const middleOf = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** 95% bootstrap interval of median(b) - median(a), with a fixed seed so reruns agree. */
export function bootstrapMedianDifference(a: ReadonlyArray<number>, b: ReadonlyArray<number>) {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const resample = (values: ReadonlyArray<number>) =>
    middleOf(Array.from(values, () => values[Math.floor(random() * values.length)]!));
  const differences = Array.from({ length: 2_000 }, () => resample(b) - resample(a)).toSorted(
    (x, y) => x - y,
  );
  return [differences[49]!, differences[1_949]!] as const;
}

export const Count = Schema.Struct({ name: Schema.String, count: Schema.Number });

/** Summed counts over samples, per sample, the largest first. */
export function topCounts(lists: ReadonlyArray<ReadonlyArray<typeof Count.Type>>, count = 5) {
  const totals = new Map<string, number>();
  for (const list of lists) {
    for (const entry of list) totals.set(entry.name, (totals.get(entry.name) ?? 0) + entry.count);
  }
  return [...totals]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name, total]) => ({ name, count: round(total / Math.max(1, lists.length), 1) }));
}

export const MachineState = Schema.Struct({
  /** The highest 1-minute load average read through the run; none on Windows. */
  load1: Schema.NullOr(Schema.Number),
  /** Cores other node, T3 and agent processes kept busy over the run; Linux only. */
  otherCpuCores: Schema.NullOr(Schema.Number),
  minutes: Schema.Number,
});
export type MachineState = typeof MachineState.Type;

/** CPU seconds spent between two reads keyed by pid and start time; a process that exited is lost. */
export function competingBetween(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
) {
  return [...after].reduce((total, [key, seconds]) => total + seconds - (before.get(key) ?? 0), 0);
}

/**
 * A run is loaded when other node, T3 and agent processes kept this share of the cores busy, or,
 * where that is unknown, when the 1-minute load passed this much per CPU. The load counts the
 * run's own agents too, so it is only the fallback.
 */
export const HEAVY_LOAD_PER_CPU = 0.75;
export const HEAVY_OTHER_CPU_SHARE = 0.25;

/** One line per side whose runs shared the machine with heavy load, so its numbers are suspect. */
export function loadWarnings(
  side: string,
  metrics: {
    readonly meta: { readonly cpus?: unknown };
    readonly runs: ReadonlyArray<{ readonly machine?: MachineState | undefined }>;
  },
) {
  const cpus = typeof metrics.meta.cpus === "number" ? metrics.meta.cpus : null;
  if (cpus === null) return [];
  const loaded = metrics.runs.flatMap(({ machine }) =>
    machine &&
    (machine.otherCpuCores === null
      ? (machine.load1 ?? 0) >= cpus * HEAVY_LOAD_PER_CPU
      : machine.otherCpuCores >= cpus * HEAVY_OTHER_CPU_SHARE)
      ? [machine]
      : [],
  );
  if (loaded.length === 0) return [];
  const worstLoad = Math.max(...loaded.map(({ load1 }) => load1 ?? 0));
  const worstOther = Math.max(...loaded.map(({ otherCpuCores }) => otherCpuCores ?? 0));
  return [
    `${side} ran under heavy load in ${loaded.length} of ${metrics.runs.length} runs (load up to ${worstLoad} on ${cpus} CPUs, other node/T3/agent processes up to ${worstOther} cores); rerun on a quieter machine before trusting a change`,
  ];
}

/** An error and the errors it wraps as one line, outermost first, repeats left out. */
export function describeFailure(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let at = error; at !== undefined && at !== null && !seen.has(at);) {
    seen.add(at);
    if (typeof at !== "object") {
      parts.push(String(at));
      break;
    }
    const tag = "_tag" in at && typeof at._tag === "string" ? at._tag : undefined;
    const message = "message" in at && typeof at.message === "string" ? at.message.trim() : "";
    const text = message || tag || String(at);
    if (!parts.some((part) => part.includes(text))) parts.push(text);
    at = "cause" in at ? at.cause : undefined;
  }
  return parts.join(": ");
}

/** Per-metric floors from `noise`, which `compare --floors` uses before the defaults. */
export const Floors = Schema.Struct({
  platform: Schema.String,
  floors: Schema.Record(
    Schema.String,
    Schema.Struct({ floor: Schema.Number, gate: Schema.Boolean }),
  ),
});
export type Floors = typeof Floors.Type;

/** Per-iteration growth that reads as a leak rather than noise. */
export const SOAK_LEAK = { heapMB: 0.05, domNodes: 5, listeners: 1 } as const;

/** The absolute change a metric must clear, past the relative threshold, to count. */
export function floorFor(metric: string) {
  if (metric.startsWith("soak.")) {
    if (metric.includes("heapMB")) return SOAK_LEAK.heapMB;
    if (metric.includes("domNodes")) return SOAK_LEAK.domNodes;
    return SOAK_LEAK.listeners;
  }
  if (metric.endsWith("Ms")) return 8;
  if (metric.endsWith("MissPct")) return 20;
  if (metric.endsWith("droppedPct")) return 5;
  if (metric.endsWith("taskPct")) return 1;
  if (metric.endsWith("heapMB")) return 3;
  if (metric.startsWith("panel.")) return 50;
  if (metric.endsWith("domNodes")) return 500;
  // Render counts barely move between runs of one commit, so small changes are real.
  if (metric.endsWith(".renders")) return 5;
  if (metric.endsWith(".commits")) return 1;
  return 0;
}

export const cell = (value: number | null, digits = 0) =>
  value === null ? "–" : `${round(value, digits)}`;

/**
 * Two files' per-run metric values side by side under `header`, by median; a metric counts when
 * its bootstrap interval clears the threshold and its floor: the calibrated one from `floors` when
 * given, else the default. A calibrated metric too noisy to gate on is shown, never counted.
 */
export function compareSeries(
  a: ReadonlyMap<string, ReadonlyArray<number>>,
  b: ReadonlyMap<string, ReadonlyArray<number>>,
  header: ReadonlyArray<string>,
  threshold = 10,
  floors?: Floors,
) {
  const lines = [
    ...header,
    "",
    "| metric | before | after | change | 95% interval | |",
    "| :-- | --: | --: | --: | --: | :-- |",
  ];
  const regressed: string[] = [];
  const improved: string[] = [];
  const noisy: string[] = [];
  let compared = 0;
  for (const metric of [...new Set([...a.keys(), ...b.keys()])].toSorted()) {
    const x = a.get(metric);
    const y = b.get(metric);
    if (!x || !y) {
      lines.push(
        `| ${metric} | ${x ? cell(median(x), 1) : "–"} | ${y ? cell(median(y), 1) : "–"} | n/a | | |`,
      );
      continue;
    }
    compared++;
    const calibrated = floors?.floors[metric];
    const mx = median(x)!;
    const my = median(y)!;
    const limit = Math.max(calibrated?.floor ?? floorFor(metric), (Math.abs(mx) * threshold) / 100);
    // Runs are the independent samples; with one a side there is no interval to gate on.
    const repeated = x.length > 1 && y.length > 1;
    const [low, high] = repeated ? bootstrapMedianDifference(x, y) : [my - mx, my - mx];
    const moved = low > limit ? "worse" : high < -limit ? "better" : "";
    const gated = repeated && (calibrated?.gate ?? true);
    const verdict =
      moved && !gated
        ? `${moved}, ${repeated ? "too noisy to gate" : "one run, not gated"}`
        : moved;
    if (moved && !gated) noisy.push(metric);
    else if (moved === "worse") regressed.push(metric);
    else if (moved === "better") improved.push(metric);
    const percent = mx === 0 ? (my === 0 ? 0 : Infinity) : ((my - mx) / Math.abs(mx)) * 100;
    const shown = Number.isFinite(percent)
      ? `${percent > 0 ? "+" : ""}${Math.round(percent)}%`
      : "new";
    const interval = repeated ? `${round(low, 1)} to ${round(high, 1)}` : "";
    lines.push(
      `| ${metric} | ${round(mx, 1)} | ${round(my, 1)} | ${shown} | ${interval} | ${verdict} |`,
    );
  }
  return { table: lines.join("\n"), regressed, improved, noisy, compared };
}

/** Two significant digits, rounded up, so a derived floor never sits under what was seen. */
const ceilSignificant = (value: number) => {
  if (value <= 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(value)) - 1);
  return round(Math.ceil(value / step) * step, 6);
};

/** An A/A interval wider than this share of a metric's median makes it too noisy to gate on. */
export const NOISY_SHARE = 0.5;

/**
 * Each metric's spread over A/A pairs (one commit against itself) as `compareSeries` sees it: the
 * 95% interval of the median difference. The floor is half the widest interval or the largest A/A
 * median difference, whichever is larger, and never under the default floor's order of rounding.
 */
export function noiseOfSeries(
  pairs: ReadonlyArray<
    readonly [
      ReadonlyMap<string, ReadonlyArray<number>>,
      ReadonlyMap<string, ReadonlyArray<number>>,
    ]
  >,
  platform: string,
) {
  const found = new Map<string, { medians: number[]; halfWidth: number; aaDifference: number }>();
  for (const [a, b] of pairs) {
    for (const [metric, x] of a) {
      const y = b.get(metric);
      if (!y) continue;
      const [low, high] =
        x.length > 1 && y.length > 1
          ? bootstrapMedianDifference(x, y)
          : [median(y)! - median(x)!, median(y)! - median(x)!];
      const entry = found.get(metric) ?? { medians: [], halfWidth: 0, aaDifference: 0 };
      entry.medians.push(median([...x, ...y])!);
      entry.halfWidth = Math.max(entry.halfWidth, (high - low) / 2);
      entry.aaDifference = Math.max(entry.aaDifference, Math.abs(median(y)! - median(x)!));
      found.set(metric, entry);
    }
  }
  const rows = [...found].toSorted().map(([metric, entry]) => {
    const middle = median(entry.medians)!;
    return {
      metric,
      median: round(middle, 2),
      halfWidth: round(entry.halfWidth, 2),
      aaDifference: round(entry.aaDifference, 2),
      defaultFloor: floorFor(metric),
      floor: ceilSignificant(Math.max(entry.halfWidth / 2, entry.aaDifference)),
      gate: entry.halfWidth <= Math.abs(middle) * NOISY_SHARE || entry.halfWidth === 0,
    };
  });
  const floors: Floors = {
    platform,
    floors: Object.fromEntries(
      rows.map((row) => [row.metric, { floor: row.floor, gate: row.gate }]),
    ),
  };
  const table = [
    "| metric | median | ± A/A interval | A/A diff | default floor | calibrated floor | gate |",
    "| :-- | --: | --: | --: | --: | --: | :-: |",
    ...rows.map(
      (row) =>
        `| ${row.metric} | ${row.median} | ${row.halfWidth} | ${row.aaDifference} | ${row.defaultFloor} | ${row.floor}${row.floor > row.defaultFloor ? " ⚠" : ""} | ${row.gate ? "yes" : "no"} |`,
    ),
  ].join("\n");
  return { rows, floors, table };
}
