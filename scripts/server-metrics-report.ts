// The pure half of scripts/server-metrics.ts: the JSON it writes, and how two of them compare.
import * as Schema from "effect/Schema";

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
});

/** One pass over the scenarios. */
export const Measured = Schema.Struct({
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
      /** Every client drops and reconnects at once. */
      storm: Schema.Struct({
        clients: Schema.Number,
        resubscribedMs: Schema.Number,
        loopDelayP99Ms: Schema.Number,
        loopDelayMaxMs: Schema.Number,
      }),
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

export const ServerMetrics = Schema.Struct({
  meta: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  runs: Schema.Array(Measured),
  /** Top CPU self time (ms) and allocated MB by function, from the last run. */
  profiles: Schema.optional(Schema.Record(Schema.String, ProfileSummary)),
  soakHeapGrowth: Schema.optional(Schema.Array(HeapGrowth)),
});
export type ServerMetrics = typeof ServerMetrics.Type;

export const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

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

function noiseFloor(metric: string) {
  if (metric.startsWith("scaling.")) return metric.endsWith("cpuPctPerThread") ? 0.2 : 2;
  if (metric.startsWith("soak.")) return 20;
  if (metric.endsWith("cpuPct")) return 1;
  if (metric.endsWith("wakeupsPerSec")) return 20;
  if (metric.endsWith("MB")) return 15;
  if (metric.endsWith("KB")) return 20;
  if (metric.includes(".shellMs.") || metric.includes(".openMs.")) return 50;
  if (metric.endsWith("loopDelayP50Ms")) return 2;
  if (metric.endsWith("loopDelayP99Ms")) return 5;
  if (metric.endsWith("loopDelayMaxMs")) return 20;
  if (metric.endsWith("gcPauseMs")) return 10;
  if (metric.endsWith("gcCount")) return 20;
  return 300;
}

const median = (values: ReadonlyArray<number>) => {
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
    median(Array.from(values, () => values[Math.floor(random() * values.length)]!));
  const differences = Array.from({ length: 2_000 }, () => resample(b) - resample(a)).toSorted(
    (x, y) => x - y,
  );
  return [differences[49]!, differences[1_949]!] as const;
}

export function compareMetrics(before: ServerMetrics, after: ServerMetrics, threshold = 10) {
  const collect = (metrics: ServerMetrics) => {
    const values = new Map<string, number[]>();
    for (const run of metrics.runs) {
      for (const [metric, value] of flatten(run)) {
        values.set(metric, [...(values.get(metric) ?? []), value]);
      }
    }
    return values;
  };
  const a = collect(before);
  const b = collect(after);
  const lines = [
    "### Server metrics (lower is better)",
    "",
    `before \`${before.meta.commit}\` (${before.runs.length} runs), after \`${after.meta.commit}\` (${after.runs.length} runs), ${after.meta.platform}${after.meta.noAgentScope ? ", no agent scope" : ""}`,
    "",
    "| metric | before | after | change | 95% interval | |",
    "| :-- | --: | --: | --: | --: | :-- |",
  ];
  const regressed: string[] = [];
  const improved: string[] = [];
  let compared = 0;
  for (const metric of new Set([...a.keys(), ...b.keys()])) {
    if (
      metric === "soak.minutes" ||
      metric.endsWith("loopSamples") ||
      metric === "busy.projects" ||
      metric === "busy.ballastMB" ||
      metric === "clients.storm.clients" ||
      metric === "busy.largeThread.messages" ||
      metric.startsWith("scaling.points")
    ) {
      continue;
    }
    const x = a.get(metric);
    const y = b.get(metric);
    if (!x || !y) {
      lines.push(`| ${metric} | ${x ? median(x) : "–"} | ${y ? median(y) : "–"} | n/a | | |`);
      continue;
    }
    // Wakeups include the delay sampler's only when `loopSamples` sits beside them, so a file
    // from before the sampler and one from after measured different things. The per-thread fit
    // comes from the quiet windows.
    const window =
      metric === "scaling.wakeupsPerThread"
        ? "quiet."
        : metric.endsWith("wakeupsPerSec")
          ? metric.slice(0, -"wakeupsPerSec".length)
          : "";
    if (window && a.has(`${window}loopSamples`) !== b.has(`${window}loopSamples`)) {
      lines.push(`| ${metric} | ${median(x)} | ${median(y)} | not comparable | | |`);
      continue;
    }
    compared++;
    const mx = median(x);
    const my = median(y);
    // A change counts only past both the relative threshold and the absolute noise floor.
    const limit = Math.max(noiseFloor(metric), (Math.abs(mx) * threshold) / 100);
    const repeated = x.length > 1 && y.length > 1;
    const [low, high] = repeated ? bootstrapMedianDifference(x, y) : [my - mx, my - mx];
    const verdict = low > limit ? "worse" : high < -limit ? "better" : "";
    if (verdict === "worse") regressed.push(metric);
    if (verdict === "better") improved.push(metric);
    const percent = mx === 0 ? (my === 0 ? 0 : Infinity) : ((my - mx) / Math.abs(mx)) * 100;
    const shown = Number.isFinite(percent)
      ? `${percent > 0 ? "+" : ""}${Math.round(percent)}%`
      : "new";
    const interval = repeated ? `${round(low, 2)} to ${round(high, 2)}` : "";
    lines.push(
      `| ${metric} | ${round(mx, 2)} | ${round(my, 2)} | ${shown} | ${interval} | ${verdict} |`,
    );
  }
  return { table: lines.join("\n"), regressed, improved, compared };
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

export const HeapSnapshot = Schema.Struct({
  snapshot: Schema.Struct({
    meta: Schema.Struct({
      node_fields: Schema.Array(Schema.String),
      node_types: Schema.Array(Schema.Union([Schema.Array(Schema.String), Schema.String])),
    }),
  }),
  nodes: Schema.Array(Schema.Number),
  strings: Schema.Array(Schema.String),
});

/** Self size by constructor from a V8 heap snapshot. */
export function heapByConstructor(snapshot: typeof HeapSnapshot.Type) {
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
