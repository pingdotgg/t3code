// The pure half of server-metrics.ts: the JSON it writes, and how two of them compare.
import * as Schema from "effect/Schema";

import { bootstrapMedianDifference, loadWarnings, MachineState, round } from "../core/report.ts";

const Window = Schema.Struct({
  cpuPct: Schema.Number,
  wakeupsPerSec: Schema.NullOr(Schema.Number),
  rssPeakMB: Schema.Number,
  rssMB: Schema.Number,
  heapAfterGcMB: Schema.Number,
  // Files written before these were recorded still decode, and compare shows them as n/a.
  /** Event-loop delay past the 10 ms sampling interval, from a histogram inside the server. */
  loopDelayP50Ms: Schema.optional(Schema.Number),
  loopDelayP99Ms: Schema.optional(Schema.Number),
  loopDelayMaxMs: Schema.optional(Schema.Number),
  /**
   * Delay samples taken. Each can wake an idle loop, so they sit inside `wakeupsPerSec` (up to
   * 100/s at rest, near none under load, when the loop is already awake); not compared.
   */
  loopSamples: Schema.optional(Schema.Number),
  /** GC events and their summed pause in the window, from a `gc` PerformanceObserver. */
  gcCount: Schema.optional(Schema.Number),
  gcPauseMs: Schema.optional(Schema.Number),
});
export type Window = typeof Window.Type;
const Spread = Schema.Struct({ median: Schema.Number, p90: Schema.Number });
const FirstWord = Schema.Struct({ toRequestMs: Spread, toDoneMs: Spread });
export type FirstWord = typeof FirstWord.Type;
const Scaling = Schema.Struct({
  heapMBPerThread: Schema.Number,
  rssMBPerThread: Schema.Number,
  cpuPctPerThread: Schema.Number,
  wakeupsPerThread: Schema.NullOr(Schema.Number),
  /** Each measured point as [threads, cpuPct, wakeupsPerSec, rssMB, heapAfterGcMB]; not compared. */
  points: Schema.Array(Schema.Array(Schema.NullOr(Schema.Number))),
});
const Soak = Schema.Struct({
  minutes: Schema.Number,
  heapMBPerHour: Schema.Number,
  rssMBPerHour: Schema.Number,
  /** Processes below the server, so agent or git children that outlive their thread show. */
  childProcessesPerHour: Schema.optional(Schema.Number),
});

const WorkingPoint = Schema.Struct({
  ...Window.fields,
  /** Turns finished inside the window, per minute; higher is better. */
  turnsPerMin: Schema.Number,
  /** Send to the agent's first API request. */
  toRequestMs: Spread,
  /** The turn's last reply byte to the client seeing the run end. */
  turnEndMs: Spread,
  /** Send to the client seeing the run end. */
  turnMs: Spread,
});
export type WorkingPoint = typeof WorkingPoint.Type;

const Reconnect = Schema.Struct({
  clients: Schema.Number,
  threadsPerClient: Schema.optional(Schema.Number),
  /** Drop to every subscription delivering its snapshot again. */
  resubscribedMs: Schema.Number,
  loopDelayP99Ms: Schema.Number,
  loopDelayMaxMs: Schema.Number,
});

/** One pass over the scenarios. */
export const Measured = Schema.Struct({
  /** What else the machine was doing during the pass; never compared, only warned about. */
  machine: Schema.optional(MachineState),
  startup: Schema.optional(Schema.Struct({ readyMs: Schema.Number })),
  rest: Schema.optional(Window),
  firstWord: Schema.optional(Schema.Struct({ inPlace: FirstWord, worktree: FirstWord })),
  quiet: Schema.optional(Window),
  scaling: Schema.optional(Scaling),
  streaming: Schema.optional(Window),
  soak: Schema.optional(Soak),
  /** One web-like client attached over the WebSocket RPC, with N threads subscribed. */
  clients: Schema.optional(
    Schema.Struct({
      /** The quiet window by subscribed thread count. */
      attached: Schema.Record(Schema.String, Window),
      /** A user's few devices, each holding the shell, VCS status and threads, drop and reconnect. */
      reconnect: Schema.optional(Reconnect),
      /** With --stress: 20 clients holding one thread each drop and reconnect at once. */
      storm: Schema.optional(Reconnect),
    }),
  ),
  /**
   * N threads in worktrees of their own run editing turns back to back, all at once, with one
   * web-like client subscribed to all of them. The scenario to steer server performance by.
   */
  working: Schema.optional(
    Schema.Struct({
      /** Each window by the number of threads working in it. */
      active: Schema.Record(Schema.String, WorkingPoint),
      /** Fits over the windows: what each additional working thread costs. */
      heapMBPerThread: Schema.Number,
      rssMBPerThread: Schema.Number,
      cpuPctPerThread: Schema.Number,
      loopDelayP99MsPerThread: Schema.Number,
    }),
  ),
  /** 50 short turns back to back on one thread. */
  pipeline: Schema.optional(
    Schema.Struct({
      /** Send to the agent's API request. */
      toRequestMs: Spread,
      /** The reply's last byte to the CLI seeing a finished run: turn end and checkpoint. */
      turnEndMs: Spread,
      /** Wall time per turn, the CLI's own start included. */
      msPerTurn: Schema.Number,
      loopDelayP99Ms: Schema.Number,
      loopDelayMaxMs: Schema.Number,
      gcPauseMs: Schema.Number,
    }),
  ),
  /** A server on a copy of the developer's real database, its projects backed by clones. */
  busy: Schema.optional(
    Schema.Struct({
      readyMs: Schema.Number,
      projects: Schema.Number,
      /** Off-heap MB the server held so its RSS is a long-lived server's; not compared. */
      ballastMB: Schema.Number,
      rest: Window,
      shellMs: Spread,
      shellKB: Schema.Number,
      /** The seeded thread with the most messages, opened through its bounded HTTP snapshot. */
      largeThread: Schema.optional(
        Schema.Struct({
          messages: Schema.Number,
          openMs: Spread,
          KB: Schema.Number,
          /** Heap after GC once it was opened, less before. */
          heapMB: Schema.Number,
        }),
      ),
      /** Back-to-back turns in a clone, each ending in a checkpoint. */
      git: Window,
    }),
  ),
});
export type Measured = typeof Measured.Type;

const Hotspot = Schema.Struct({ frame: Schema.String, value: Schema.Number });
export type Hotspot = typeof Hotspot.Type;
const ProfileSummary = Schema.Struct({
  cpuMs: Schema.Array(Hotspot),
  allocatedMB: Schema.Array(Hotspot),
});
export type ProfileSummary = typeof ProfileSummary.Type;
export const HeapGrowth = Schema.Struct({
  constructor: Schema.String,
  count: Schema.Number,
  MB: Schema.Number,
});

/** An object whose retained size grew at every soak snapshot, and how it is reached. */
export const RetainerGrowth = Schema.Struct({
  path: Schema.String,
  MB: Schema.Number,
  retainedMB: Schema.Number,
});
export type RetainerGrowth = typeof RetainerGrowth.Type;

export const ServerMetrics = Schema.Struct({
  meta: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  runs: Schema.Array(Measured),
  /** Top CPU self time (ms) and allocated MB by function, from the last run. */
  profiles: Schema.optional(Schema.Record(Schema.String, ProfileSummary)),
  soakHeapGrowth: Schema.optional(Schema.Array(HeapGrowth)),
  soakRetainerGrowth: Schema.optional(Schema.Array(RetainerGrowth)),
});
export type ServerMetrics = typeof ServerMetrics.Type;

/** `ps -o time=` CPU time, `[[dd-]hh:]mm:ss[.ss]`, in seconds; NaN for anything else. */
export function parsePsCpuTime(text: string) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (match === null) return Number.NaN;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/**
 * `--only`, `--threads` and `--soak` as run options. Thread counts must ascend because threads stay
 * open, so a lower count after a higher one would mislabel its window. A soak alone runs nothing else.
 */
export function parseRunSelection(input: {
  readonly only: string;
  readonly threads: string;
  readonly soak: number;
  readonly scenarios: ReadonlyArray<string>;
}):
  | { readonly only: ReadonlyArray<string>; readonly threads: ReadonlyArray<number> }
  | { readonly error: string } {
  const only = input.only.split(",").filter(Boolean);
  const unknown = only.filter((name) => !input.scenarios.includes(name));
  if (unknown.length > 0) return { error: `unknown scenario: ${unknown.join(", ")}` };
  const threads = input.threads
    .split(",")
    .map((count) => (count.trim() === "" ? Number.NaN : Number(count)));
  if (
    threads.some(
      (count, index) => !Number.isInteger(count) || count < 0 || count < (threads[index - 1] ?? 0),
    )
  ) {
    return { error: "--threads takes ascending counts such as 0,5,10,20" };
  }
  if (!Number.isInteger(input.soak) || input.soak < 0)
    return { error: "--soak takes minutes, 0 for none" };
  return { only: input.soak > 0 && only.length === 0 ? ["none"] : only, threads };
}

export function spread(values: ReadonlyArray<number>) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { median: Math.round(at(0.5) ?? 0), p90: Math.round(at(0.9) ?? 0) };
}

/** Least-squares slope of y over x. */
export function slope(points: ReadonlyArray<readonly [number, number]>) {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((sum, [x]) => sum + x, 0) / n;
  const my = points.reduce((sum, [, y]) => sum + y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - mx) * (y - my);
    denominator += (x - mx) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Numeric leaves by dotted path, such as `quiet.cpuPct` or `firstWord.worktree.toRequestMs.p90`. */
export function flatten(measured: Measured): Map<string, number> {
  const values = new Map<string, number>();
  const visit = (value: unknown, path: string) => {
    if (typeof value === "number") values.set(path, value);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(measured, "");
  return values;
}

/**
 * How far a metric moves between runs of the same commit, and whether it moves little enough to
 * gate on. First match wins. Re-derive from A/A files with `server-metrics noise`; see
 * docs/internals/performance-regressions.md for the runs these came from.
 */
export interface NoiseRule {
  readonly pattern: RegExp;
  /** Absolute change a metric must clear on top of the relative threshold. */
  readonly floor: number;
  /** False for metrics an A/A run moves too far to gate on: shown, never counted. */
  readonly gate: boolean;
}

/** Shown, never counted: these A/A intervals were wider than half the metric (see `noise`). */
const informational = (pattern: RegExp): NoiseRule => ({ pattern, floor: 0, gate: false });

// Estimated from A/A runs on cups (16 cores, load 1 to 20) on 2026-11-23, with and without the
// agent scope, rounded up and taking the larger of the two.
// busy and soak had no A/A run and keep the earlier floors.
export const NOISE_RULES: ReadonlyArray<NoiseRule> = [
  informational(/loopDelayP50Ms$/),
  informational(/^(rest|quiet|streaming|clients\.attached\.\d+)\.loopDelay(P99|Max)Ms$/),
  informational(/^(rest|quiet|clients\.attached\.\d+)\.gc(Count|PauseMs)$/),
  informational(/^(streaming|pipeline)\.gcPauseMs$/),
  informational(
    /^(pipeline\.loopDelayMaxMs|clients\.(storm|reconnect)\.loopDelayP99Ms|quiet\.cpuPct)$/,
  ),
  informational(/^scaling\.(cpuPct|wakeups)PerThread$/),
  informational(/^clients\.attached\.\d+\.(cpuPct|wakeupsPerSec)$/),
  informational(/^(firstWord\..*|pipeline\.turnEndMs)\.p90$/),
  { pattern: /^scaling\.heapMBPerThread$/, floor: 0.06, gate: true },
  { pattern: /^scaling\.rssMBPerThread$/, floor: 0.2, gate: true },
  { pattern: /^soak\./, floor: 20, gate: true },
  informational(/^working\.(cpuPct|loopDelayP99Ms)PerThread$/),
  informational(/^working\.active\.\d+\.(wakeupsPerSec|loopDelayMaxMs|gcPauseMs)$/),
  { pattern: /^working\.heapMBPerThread$/, floor: 0.06, gate: true },
  { pattern: /^working\.rssMBPerThread$/, floor: 0.2, gate: true },
  { pattern: /^working\.active\.\d+\.turnsPerMin$/, floor: 4, gate: true },
  { pattern: /^working\.active\.\d+\.toRequestMs\.median$/, floor: 1_100, gate: true },
  { pattern: /^working\.active\.\d+\.turnEndMs\.median$/, floor: 1_700, gate: true },
  {
    pattern: /^working\.active\.\d+\.(toRequestMs\.p90|turnMs\.median)$/,
    floor: 1_900,
    gate: true,
  },
  { pattern: /^working\.active\.\d+\.turnEndMs\.p90$/, floor: 2_200, gate: true },
  { pattern: /^working\.active\.\d+\.turnMs\.p90$/, floor: 2_800, gate: true },
  // Peak RSS while 20 agents run swings by a checkpoint's git children; the settled RSS does not.
  { pattern: /^working\.active\.\d+\.rssPeakMB$/, floor: 170, gate: true },
  { pattern: /^working\.active\.\d+\.(cpuPct|loopDelayP99Ms)$/, floor: 5, gate: true },
  { pattern: /^working\.active\.\d+\.gcCount$/, floor: 8, gate: true },
  { pattern: /^startup\.readyMs$/, floor: 600, gate: true },
  { pattern: /^firstWord\./, floor: 600, gate: true },
  { pattern: /^pipeline\.(toRequestMs|turnEndMs)\.median$/, floor: 300, gate: true },
  { pattern: /^pipeline\.(toRequestMs\.p90|msPerTurn)$/, floor: 600, gate: true },
  // The reconnect had no A/A run yet and takes the storm's floors.
  { pattern: /^clients\.(storm|reconnect)\.resubscribedMs$/, floor: 200, gate: true },
  { pattern: /^rest\.cpuPct$/, floor: 1, gate: true },
  { pattern: /cpuPct$/, floor: 3.5, gate: true },
  { pattern: /^(rest|quiet)\.wakeupsPerSec$/, floor: 12, gate: true },
  { pattern: /wakeupsPerSec$/, floor: 110, gate: true },
  { pattern: /rssPeakMB$/, floor: 16, gate: true },
  { pattern: /rssMB$/, floor: 4, gate: true },
  { pattern: /heapAfterGcMB$/, floor: 1, gate: true },
  { pattern: /MB$/, floor: 15, gate: true },
  { pattern: /KB$/, floor: 20, gate: true },
  { pattern: /\.(shellMs|openMs)\./, floor: 50, gate: true },
  { pattern: /loopDelayP99Ms$/, floor: 3, gate: true },
  { pattern: /loopDelayMaxMs$/, floor: 22, gate: true },
  { pattern: /gcPauseMs$/, floor: 55, gate: true },
  { pattern: /gcCount$/, floor: 6, gate: true },
  { pattern: /./, floor: 300, gate: true },
];

// Estimated from one quick A/A run (3 rounds) on a 4-vCPU Azure Windows Server 2025 VM on
// 2026-11-23, rounded up. Consulted before NOISE_RULES on that OS. macOS has no A/A run yet and
// takes the defaults.
const NOISE_RULE_OVERRIDES: Partial<Record<string, ReadonlyArray<NoiseRule>>> = {
  win32: [
    informational(/^working\.active\.20\.toRequestMs\.p90$/),
    { pattern: /^working\.rssMBPerThread$/, floor: 0.6, gate: true },
    { pattern: /^scaling\.rssMBPerThread$/, floor: 0.5, gate: true },
    { pattern: /^working\.active\.\d+\.rssMB$/, floor: 10, gate: true },
    { pattern: /^working\.active\.\d+\.loopDelayP99Ms$/, floor: 6, gate: true },
    { pattern: /^pipeline\.loopDelayP99Ms$/, floor: 8, gate: true },
    { pattern: /^streaming\.heapAfterGcMB$/, floor: 1.5, gate: true },
  ],
};

/**
 * The rules for the platform (`meta.platform`, e.g. `win32-x64`) every file recorded. Files from
 * different platforms get the defaults and a warning.
 */
export function noiseRulesFor(files: ReadonlyArray<ServerMetrics>) {
  const platforms = [...new Set(files.map(({ meta }) => String(meta.platform ?? "")))];
  if (platforms.length !== 1) {
    return {
      rules: NOISE_RULES,
      warning: `the files come from ${platforms.join(" and ")}, so the default noise floors apply`,
    };
  }
  const overrides = NOISE_RULE_OVERRIDES[platforms[0]!.split("-")[0]!] ?? [];
  return { rules: [...overrides, ...NOISE_RULES], warning: undefined };
}

export function noiseRule(metric: string, rules: ReadonlyArray<NoiseRule> = NOISE_RULES) {
  return rules.find((rule) => rule.pattern.test(metric)) ?? { floor: 0, gate: true };
}

/** Why two files cannot be compared at all: a quick run measures shorter windows than a full one. */
export function profileMismatch(before: ServerMetrics, after: ServerMetrics) {
  const profile = (metrics: ServerMetrics) => metrics.meta.profile ?? "full";
  return profile(before) === profile(after)
    ? undefined
    : `before is a ${profile(before)} run and after a ${profile(after)} one; compare quick runs only with quick runs`;
}

/** Throughput, where a drop is the regression. */
export const higherIsBetter = (metric: string) => metric.endsWith("PerMin");

/** Fields that describe a run rather than measure it. */
const isMetric = (metric: string) =>
  !(
    metric === "soak.minutes" ||
    metric.startsWith("machine.") ||
    metric.endsWith("loopSamples") ||
    metric === "busy.projects" ||
    metric === "busy.ballastMB" ||
    metric.endsWith(".clients") ||
    metric.endsWith(".threadsPerClient") ||
    metric.endsWith(".threads") ||
    metric === "busy.largeThread.messages" ||
    metric.startsWith("scaling.points")
  );

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * False for a wakeup count where only one side had the delay sampler: wakeups include the
 * sampler's only when `loopSamples` sits beside them, so the two measured different things. The
 * per-thread fit comes from the quiet windows, so it follows their method.
 */
function sameWakeupMethod(
  metric: string,
  a: ReadonlyMap<string, unknown>,
  b: ReadonlyMap<string, unknown>,
) {
  const window =
    metric === "scaling.wakeupsPerThread"
      ? "quiet."
      : metric.endsWith("wakeupsPerSec")
        ? metric.slice(0, -"wakeupsPerSec".length)
        : "";
  return !window || a.has(`${window}loopSamples`) === b.has(`${window}loopSamples`);
}

/** Why a directory is not an A/A pair: its files must record one and the same commit. */
export function noisePairProblem(dir: string, a: ServerMetrics, b: ServerMetrics) {
  const commits = [a.meta.commit, b.meta.commit];
  if (commits.some((commit) => typeof commit !== "string" || commit === "")) {
    return `${dir}: a.json or b.json records no commit, so it cannot be shown to be an A/A run`;
  }
  return commits[0] === commits[1]
    ? undefined
    : `${dir}: a.json is ${commits[0]} and b.json ${commits[1]}; noise floors need one commit against itself`;
}

/** Every metric's values across a file's runs. */
const collect = (metrics: ServerMetrics) => {
  const values = new Map<string, number[]>();
  for (const run of metrics.runs) {
    for (const [metric, value] of flatten(run)) {
      values.set(metric, [...(values.get(metric) ?? []), value]);
    }
  }
  return values;
};

/** Two significant digits, rounded up, so a derived floor never sits under what was seen. */
const ceilSignificant = (value: number) => {
  if (value <= 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(value)) - 1);
  return round(Math.ceil(value / step) * step, 6);
};

/** An A/A interval wider than this share of a metric's median makes it informational. */
export const NOISY_SHARE = 0.5;

export interface NoiseRow {
  readonly metric: string;
  readonly median: number;
  /** The widest half-width of an A/A pair's 95% interval of the median difference. */
  readonly halfWidth: number;
  /** The largest |median(A) - median(B)| over the A/A pairs. */
  readonly aaDifference: number;
  readonly floor: number;
  readonly suggestedFloor: number;
  readonly gate: boolean;
  readonly suggestedGate: boolean;
}

/**
 * Each metric's A/A spread as `compare` sees it: the 95% interval of the median difference. The
 * estimated floor (half the widest half-width, or the A/A median difference if larger) is how far
 * an A/A interval must miss zero to flag. It is an estimate, not a bound.
 */
export function noiseReport(
  pairs: ReadonlyArray<readonly [ServerMetrics, ServerMetrics]>,
  rules: ReadonlyArray<NoiseRule> = noiseRulesFor(pairs.flat()).rules,
) {
  const found = new Map<string, { medians: number[]; halfWidth: number; aaDifference: number }>();
  for (const [before, after] of pairs) {
    const a = collect(before);
    const b = collect(after);
    for (const [metric, x] of a) {
      const y = b.get(metric);
      if (!y || !isMetric(metric) || !sameWakeupMethod(metric, a, b)) continue;
      const [low, high] = bootstrapMedianDifference(x, y);
      const entry = found.get(metric) ?? { medians: [], halfWidth: 0, aaDifference: 0 };
      entry.medians.push(median([...x, ...y]));
      entry.halfWidth = Math.max(entry.halfWidth, (high - low) / 2);
      entry.aaDifference = Math.max(entry.aaDifference, Math.abs(median(y) - median(x)));
      found.set(metric, entry);
    }
  }
  const rows: NoiseRow[] = [...found].map(([metric, entry]) => {
    const middle = median(entry.medians);
    const rule = noiseRule(metric, rules);
    return {
      metric,
      median: round(middle, 2),
      halfWidth: round(entry.halfWidth, 2),
      aaDifference: round(entry.aaDifference, 2),
      floor: rule.floor,
      suggestedFloor: ceilSignificant(Math.max(entry.halfWidth / 2, entry.aaDifference)),
      gate: rule.gate,
      suggestedGate: entry.halfWidth <= Math.abs(middle) * NOISY_SHARE,
    };
  });
  const lines = [
    "| metric | median | ± A/A interval | A/A diff | floor | estimated floor | gated | suggest gating |",
    "| :-- | --: | --: | --: | --: | --: | :-: | :-: |",
    ...rows.map(
      (row) =>
        `| ${row.metric} | ${row.median} | ${row.halfWidth} | ${row.aaDifference} | ${row.floor} | ${row.suggestedFloor}${row.suggestedFloor > row.floor ? " ⚠" : ""} | ${row.gate ? "yes" : "no"} | ${row.suggestedGate ? "yes" : "no"} |`,
    ),
  ];
  return { rows, table: lines.join("\n") };
}

export function compareMetrics(
  before: ServerMetrics,
  after: ServerMetrics,
  threshold = 10,
  rules?: ReadonlyArray<NoiseRule>,
) {
  const forPlatform = noiseRulesFor([before, after]);
  const gating = rules ?? forPlatform.rules;
  const a = collect(before);
  const b = collect(after);
  const lines = [
    "### Server metrics (lower is better, except throughput per minute)",
    "",
    `before \`${before.meta.commit}\` (${before.runs.length} runs), after \`${after.meta.commit}\` (${after.runs.length} runs), ${after.meta.platform}${after.meta.noAgentScope ? ", no agent scope" : ""}`,
    "",
    "| metric | before | after | change | 95% interval | |",
    "| :-- | --: | --: | --: | --: | :-- |",
  ];
  const regressed: string[] = [];
  const improved: string[] = [];
  let compared = 0;
  const informational: string[] = [];
  for (const metric of new Set([...a.keys(), ...b.keys()])) {
    if (!isMetric(metric)) continue;
    const x = a.get(metric);
    const y = b.get(metric);
    if (!x || !y) {
      lines.push(`| ${metric} | ${x ? median(x) : "–"} | ${y ? median(y) : "–"} | n/a | | |`);
      continue;
    }
    // Wakeups include the delay sampler's only when `loopSamples` sits beside them, so a file
    // from before the sampler and one from after measured different things. The per-thread fit
    // comes from the quiet windows.
    if (!sameWakeupMethod(metric, a, b)) {
      lines.push(`| ${metric} | ${median(x)} | ${median(y)} | not comparable | | |`);
      continue;
    }
    compared++;
    const mx = median(x);
    const my = median(y);
    // A change counts only past both the relative threshold and the absolute noise floor.
    const rule = noiseRule(metric, gating);
    const limit = Math.max(rule.floor, (Math.abs(mx) * threshold) / 100);
    const repeated = x.length > 1 && y.length > 1;
    const [low, high] = repeated ? bootstrapMedianDifference(x, y) : [my - mx, my - mx];
    const up = low > limit ? "worse" : high < -limit ? "better" : "";
    const moved = higherIsBetter(metric) ? { worse: "better", better: "worse", "": "" }[up] : up;
    if (moved && !rule.gate) informational.push(metric);
    else if (moved === "worse") regressed.push(metric);
    else if (moved === "better") improved.push(metric);
    const verdict = rule.gate ? moved : moved ? `${moved} (noisy, not gated)` : "noisy";
    const percent = mx === 0 ? (my === 0 ? 0 : Infinity) : ((my - mx) / Math.abs(mx)) * 100;
    const shown = Number.isFinite(percent)
      ? `${percent > 0 ? "+" : ""}${Math.round(percent)}%`
      : "new";
    const interval = repeated ? `${round(low, 2)} to ${round(high, 2)}` : "";
    lines.push(
      `| ${metric} | ${round(mx, 2)} | ${round(my, 2)} | ${shown} | ${interval} | ${verdict} |`,
    );
  }
  const warnings = [
    ...(rules || !forPlatform.warning ? [] : [forPlatform.warning]),
    ...loadWarnings("before", before),
    ...loadWarnings("after", after),
  ];
  return { table: lines.join("\n"), regressed, improved, informational, compared, warnings };
}

const CallFrame = Schema.Struct({
  functionName: Schema.String,
  url: Schema.String,
  lineNumber: Schema.Number,
});
type CallFrame = typeof CallFrame.Type;
export const CpuProfile = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({ callFrame: CallFrame, hitCount: Schema.optional(Schema.Number) }),
  ),
  samples: Schema.optional(Schema.Array(Schema.Number)),
  startTime: Schema.Number,
  endTime: Schema.Number,
});
interface HeapProfileNode {
  readonly callFrame: CallFrame;
  readonly selfSize: number;
  readonly children: ReadonlyArray<HeapProfileNode>;
}
const HeapProfileNode: Schema.Codec<HeapProfileNode> = Schema.Struct({
  callFrame: CallFrame,
  selfSize: Schema.Number,
  children: Schema.Array(Schema.suspend(() => HeapProfileNode)),
});
export const HeapProfile = Schema.Struct({ head: HeapProfileNode });

const shortUrl = (url: string) =>
  url
    .replace(/^file:\/\//, "")
    .split(/[\\/]/)
    .slice(-3)
    .join("/");
const frameName = (frame: CallFrame) =>
  `${frame.functionName || "(anonymous)"} ${frame.url ? `${shortUrl(frame.url)}:${frame.lineNumber + 1}` : ""}`.trim();
const top = (totals: Map<string, number>, digits: number): Hotspot[] =>
  [...totals]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([frame, value]) => ({ frame, value: round(value, digits) }));

/** Top CPU self time in ms and allocated MB, by function. */
export function summarizeProfiles(
  cpu: typeof CpuProfile.Type,
  heap: typeof HeapProfile.Type,
): ProfileSummary {
  const perSampleMs = (cpu.endTime - cpu.startTime) / 1_000 / Math.max(1, cpu.samples?.length ?? 1);
  const cpuTotals = new Map<string, number>();
  for (const node of cpu.nodes) {
    if (!node.hitCount || node.callFrame.functionName === "(idle)") continue;
    const name = frameName(node.callFrame);
    cpuTotals.set(name, (cpuTotals.get(name) ?? 0) + node.hitCount * perSampleMs);
  }
  const allocations = new Map<string, number>();
  const visit = (node: HeapProfileNode) => {
    const name = frameName(node.callFrame);
    allocations.set(name, (allocations.get(name) ?? 0) + node.selfSize / 1e6);
    for (const child of node.children) visit(child);
  };
  visit(heap.head);
  return { cpuMs: top(cpuTotals, 0), allocatedMB: top(allocations, 1) };
}

const TypeNames = Schema.Array(Schema.Union([Schema.Array(Schema.String), Schema.String]));
export const HeapSnapshot = Schema.Struct({
  snapshot: Schema.Struct({
    meta: Schema.Struct({
      node_fields: Schema.Array(Schema.String),
      node_types: TypeNames,
      edge_fields: Schema.Array(Schema.String),
      edge_types: TypeNames,
    }),
  }),
  nodes: Schema.Array(Schema.Number),
  edges: Schema.Array(Schema.Number),
  strings: Schema.Array(Schema.String),
});
type HeapSnapshot = typeof HeapSnapshot.Type;

/** Self size by constructor from a V8 heap snapshot. */
export function heapByConstructor(snapshot: HeapSnapshot) {
  const fields = snapshot.snapshot.meta.node_fields;
  const typeNames = snapshot.snapshot.meta.node_types[0];
  const types = Array.isArray(typeNames) ? typeNames : [];
  const typeAt = fields.indexOf("type");
  const nameAt = fields.indexOf("name");
  const sizeAt = fields.indexOf("self_size");
  const totals = new Map<string, { count: number; bytes: number }>();
  for (let index = 0; index < snapshot.nodes.length; index += fields.length) {
    const type = types[snapshot.nodes[index + typeAt]!] ?? "?";
    const label = snapshot.strings[snapshot.nodes[index + nameAt]!] ?? "";
    const name =
      type === "object"
        ? label.slice(0, 80)
        : type === "closure"
          ? `(closure) ${label.slice(0, 60)}`
          : `(${type.replace(/^(concatenated|sliced) /, "")})`;
    const entry = totals.get(name) ?? { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += snapshot.nodes[index + sizeAt]!;
    totals.set(name, entry);
  }
  return totals;
}

/** The constructors whose heap grew most from one snapshot to the next. */
export function heapGrowth(
  before: ReturnType<typeof heapByConstructor>,
  after: ReturnType<typeof heapByConstructor>,
) {
  return [...after]
    .map(([name, { count, bytes }]) => ({
      constructor: name,
      count: count - (before.get(name)?.count ?? 0),
      bytes: bytes - (before.get(name)?.bytes ?? 0),
    }))
    .filter((entry) => entry.bytes > 0)
    .toSorted((a, b) => b.bytes - a.bytes)
    .slice(0, 25)
    .map(({ bytes, ...entry }) => ({ ...entry, MB: round(bytes / 1e6, 2) }));
}

interface Retainer {
  readonly retained: number;
  /** The id of the node that dominates this one, none for the root. */
  readonly dominator: number | undefined;
  /** Empty below `pathBytes`: such a node is only kept to compare sizes across snapshots. */
  readonly path: string;
}

const TEXT_NODES = new Set(["string", "concatenated string", "sliced string", "regexp", "number"]);
const IDENTIFIER = /^[A-Za-z_$#][\w$]{0,48}$/;

/**
 * Retained size by node id for every node retaining at least `minBytes`, and for those retaining
 * `pathBytes` the shortest strong path from the root to it. Node ids are stable within one process, so snapshots of one
 * server line up. Paths name only code: string contents and non-identifier keys are left out.
 */
export function heapRetainers(snapshot: HeapSnapshot, minBytes = 16_000, pathBytes = 256_000) {
  const { meta } = snapshot.snapshot;
  const nodeFields = meta.node_fields.length;
  const edgeFields = meta.edge_fields.length;
  const list = (names: typeof meta.node_types) => {
    const first = names[0];
    return Array.isArray(first) ? first : [];
  };
  const nodeTypes = list(meta.node_types);
  const edgeTypes = list(meta.edge_types);
  const [typeAt, nameAt, idAt, sizeAt, edgeCountAt] = [
    "type",
    "name",
    "id",
    "self_size",
    "edge_count",
  ].map((field) => meta.node_fields.indexOf(field)) as [number, number, number, number, number];
  const [edgeTypeAt, edgeNameAt, toAt] = ["type", "name_or_index", "to_node"].map((field) =>
    meta.edge_fields.indexOf(field),
  ) as [number, number, number];
  const { nodes, edges, strings } = snapshot;
  const count = nodes.length / nodeFields;
  const firstEdge = new Uint32Array(count + 1);
  for (let node = 0, offset = 0; node < count; node++) {
    firstEdge[node] = offset;
    offset += nodes[node * nodeFields + edgeCountAt]! * edgeFields;
    firstEdge[node + 1] = offset;
  }
  const weak = edgeTypes.indexOf("weak");
  const shortcut = edgeTypes.indexOf("shortcut");
  const strong = (edge: number) =>
    edges[edge + edgeTypeAt] !== weak && edges[edge + edgeTypeAt] !== shortcut;
  const target = (edge: number) => edges[edge + toAt]! / nodeFields;

  // Postorder from the root, then dominators by Cooper, Harvey and Kennedy's iteration.
  const postorder = new Int32Array(count).fill(-1);
  const order = new Int32Array(count);
  const stack = new Int32Array(count);
  const cursor = new Uint32Array(count);
  const seen = new Uint8Array(count);
  let depth = 0;
  let visited = 0;
  stack[depth++] = 0;
  seen[0] = 1;
  cursor[0] = firstEdge[0]!;
  while (depth > 0) {
    const node = stack[depth - 1]!;
    if (cursor[node]! < firstEdge[node + 1]!) {
      const edge = cursor[node]!;
      cursor[node] = edge + edgeFields;
      const next = target(edge);
      if (strong(edge) && !seen[next]) {
        seen[next] = 1;
        cursor[next] = firstEdge[next]!;
        stack[depth++] = next;
      }
    } else {
      depth--;
      postorder[node] = visited;
      order[visited++] = node;
    }
  }
  const predecessorStart = new Uint32Array(count + 1);
  for (let node = 0; node < count; node++) {
    if (!seen[node]) continue;
    for (let edge = firstEdge[node]!; edge < firstEdge[node + 1]!; edge += edgeFields) {
      if (strong(edge)) predecessorStart[target(edge) + 1]!++;
    }
  }
  for (let node = 0; node < count; node++) predecessorStart[node + 1]! += predecessorStart[node]!;
  const predecessors = new Int32Array(predecessorStart[count]!);
  const fill = predecessorStart.slice(0, count);
  for (let node = 0; node < count; node++) {
    if (!seen[node]) continue;
    for (let edge = firstEdge[node]!; edge < firstEdge[node + 1]!; edge += edgeFields) {
      if (strong(edge)) predecessors[fill[target(edge)]!++] = node;
    }
  }
  const dominator = new Int32Array(count).fill(-1);
  dominator[0] = 0;
  const intersect = (left: number, right: number) => {
    while (left !== right) {
      while (postorder[left]! < postorder[right]!) left = dominator[left]!;
      while (postorder[right]! < postorder[left]!) right = dominator[right]!;
    }
    return left;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let index = visited - 2; index >= 0; index--) {
      const node = order[index]!;
      let found = -1;
      for (let at = predecessorStart[node]!; at < predecessorStart[node + 1]!; at++) {
        const predecessor = predecessors[at]!;
        if (dominator[predecessor] === -1) continue;
        found = found === -1 ? predecessor : intersect(predecessor, found);
      }
      if (found !== -1 && dominator[node] !== found) {
        dominator[node] = found;
        changed = true;
      }
    }
  }
  const retained = new Float64Array(count);
  for (let node = 0; node < count; node++) retained[node] = nodes[node * nodeFields + sizeAt]!;
  for (let index = 0; index < visited - 1; index++) {
    const node = order[index]!;
    retained[dominator[node]!]! += retained[node]!;
  }

  const parent = new Int32Array(count).fill(-1);
  const parentEdge = new Int32Array(count).fill(-1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  queue[tail++] = 0;
  parent[0] = 0;
  while (head < tail) {
    const node = queue[head++]!;
    for (let edge = firstEdge[node]!; edge < firstEdge[node + 1]!; edge += edgeFields) {
      const next = target(edge);
      if (!strong(edge) || parent[next] !== -1) continue;
      parent[next] = node;
      parentEdge[next] = edge;
      queue[tail++] = next;
    }
  }
  const nodeType = (node: number) => nodeTypes[nodes[node * nodeFields + typeAt]!] ?? "?";
  const label = (node: number) => {
    const type = nodeType(node);
    if (TEXT_NODES.has(type)) return `(${type})`;
    const name = strings[nodes[node * nodeFields + nameAt]!] ?? "";
    const shown = name.length > 60 || /["'`\n\\]|:\/\/|(^|\s)\/[\w.]/.test(name) ? "?" : name;
    if (type === "object") return shown;
    if (type === "closure") return `${shown || "(anonymous)"}()`;
    return `(${type}${shown ? ` ${shown}` : ""})`;
  };
  const edgeName = (edge: number) => {
    const type = edgeTypes[edges[edge + edgeTypeAt]!];
    const value = edges[edge + edgeNameAt]!;
    if (type === "element" || type === "hidden") return `[${value}]`;
    const name = strings[value] ?? "";
    return IDENTIFIER.test(name) ? name : "<key>";
  };
  const pathTo = (node: number) => {
    const steps: string[] = [];
    for (let at = node; at !== 0 && steps.length < 40; at = parent[at]!) {
      if (parent[at] === -1) return "(unreachable)";
      const from = parent[at]!;
      steps.push(
        from === 0 || nodeType(from) === "synthetic"
          ? edgeName(parentEdge[at]!)
          : `${label(from)}.${edgeName(parentEdge[at]!)}`,
      );
      if (nodeType(from) === "synthetic") break;
    }
    const shown = steps.reverse();
    return [...(shown.length > 6 ? ["…", ...shown.slice(-6)] : shown), label(node)].join(" → ");
  };
  const result = new Map<number, Retainer>();
  for (let node = 0; node < count; node++) {
    if (!seen[node] || retained[node]! < minBytes) continue;
    result.set(nodes[node * nodeFields + idAt]!, {
      retained: retained[node]!,
      dominator: node === 0 ? undefined : nodes[dominator[node]! * nodeFields + idAt]!,
      path:
        retained[node]! < pathBytes
          ? ""
          : nodeType(node) === "synthetic"
            ? label(node)
            : pathTo(node),
    });
  }
  return result;
}

/**
 * The objects whose retained size grew from each snapshot to the next, at least `minBytes` in all.
 * An object is left out when a reported object it dominates holds at least 80% of its growth: of
 * a chain that grew by about the same amount, only the deepest is kept, the container holding the
 * growth. Nested objects whose growth differs are each reported.
 */
export function retainerGrowth(
  snapshots: ReadonlyArray<ReadonlyMap<number, Retainer>>,
  minBytes = 1_000_000,
) {
  const last = snapshots.at(-1);
  if (last === undefined || snapshots.length < 2) return [];
  const growth = new Map<number, number>();
  for (const [id, { retained, path }] of last) {
    if (path === "" || path.startsWith("(synthetic")) continue;
    const sizes = [
      ...snapshots.slice(0, -1).map((snapshot) => snapshot.get(id)?.retained ?? 0),
      retained,
    ];
    const grewEachTime = sizes.every((size, index) => index === 0 || size > sizes[index - 1]!);
    const grown = retained - sizes[0]!;
    if (grewEachTime && grown >= minBytes) growth.set(id, grown);
  }
  const ancestors = (id: number) => {
    const found: number[] = [];
    for (let at = last.get(id)?.dominator; at !== undefined && found.length < 500;) {
      found.push(at);
      at = last.get(at)?.dominator;
    }
    return found;
  };
  // Deepest first, so every descendant is decided before its ancestors: a row is left out
  // only when a reported descendant holds at least 80% of its growth.
  const heldBelow = new Map<number, number>();
  const kept: Array<[number, number]> = [];
  const depth = new Map([...growth.keys()].map((id) => [id, ancestors(id).length]));
  const order = [...growth].toSorted((a, b) => depth.get(b[0])! - depth.get(a[0])!);
  for (const [id, grown] of order) {
    if ((heldBelow.get(id) ?? 0) >= grown * 0.8) continue;
    kept.push([id, grown]);
    for (const ancestor of ancestors(id)) {
      heldBelow.set(ancestor, Math.max(heldBelow.get(ancestor) ?? 0, grown));
    }
  }
  const rows: RetainerGrowth[] = kept
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, grown]) => ({
      path: last.get(id)!.path,
      MB: round(grown / 1e6, 2),
      retainedMB: round(last.get(id)!.retained / 1e6, 2),
    }));
  return rows;
}

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const spellings: ReadonlyArray<(path: string) => string> = [
  (path) => path,
  // Inside a JSON string, with every escape JSON applies: backslashes, quotes, control characters.
  (path) => encodeJsonString(path).slice(1, -1),
  (path) => path.replaceAll("\\", "/"),
];

/** How a path can appear in a database's text: as written, JSON-escaped, with forward slashes. */
export function pathSpellings(path: string) {
  return [...new Set(spellings.map((spell) => spell(path)))];
}

/** Each spelling of `from` with the same spelling of `to`, for a textual rewrite. */
export function pathRewrites(from: string, to: string) {
  const pairs = new Map(spellings.map((spell) => [spell(from), spell(to)] as const));
  return [...pairs];
}

/**
 * When the next activity report goes out, `intervalMs` after the previous send, and whether it
 * starts too late to renew the lease that send took: past `latestMs`, a renewal can land after it
 * lapsed.
 */
export function nextActivityReport(
  lastSentAt: number,
  now: number,
  intervalMs = 25_000,
  latestMs = 40_000,
) {
  const due = lastSentAt + intervalMs;
  return { waitMs: Math.max(0, due - now), late: Math.max(due, now) - lastSentAt > latestMs };
}

/**
 * Whether a renewal let the previous send's lease lapse: it went out past `latestMs` after that
 * send (a stalled loop wakes late), or its answer came after the lease (`leaseMs`) ran out.
 */
export function activityRenewalMissed(
  previousSentAt: number,
  sentAt: number,
  repliedAt: number,
  latestMs = 40_000,
  leaseMs = 45_000,
) {
  return sentAt - previousSentAt > latestMs || repliedAt - previousSentAt > leaseMs;
}
