// What a Chromium trace of client-metrics.ts says about each measured step: the input's
// task, the style and layout scripts forced inside it, where its JS time went by original source,
// and the long tasks that followed. Pure, so it is tested on synthetic events.
import * as Schema from "effect/Schema";

import { round } from "../core/report.ts";

const StackFrame = Schema.Struct({
  url: Schema.String,
  functionName: Schema.optional(Schema.String),
  lineNumber: Schema.Number,
  columnNumber: Schema.Number,
});
const CallFrame = Schema.Struct({
  functionName: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  /** 0-based, unlike stack trace frames. */
  lineNumber: Schema.optional(Schema.Number),
  columnNumber: Schema.optional(Schema.Number),
});
const ProfileNode = Schema.Struct({
  id: Schema.Number,
  parent: Schema.optional(Schema.Number),
  callFrame: CallFrame,
});
export const TraceEvent = Schema.Struct({
  name: Schema.optional(Schema.String),
  cat: Schema.optional(Schema.String),
  ph: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  tid: Schema.optional(Schema.Number),
  ts: Schema.optional(Schema.Number),
  dur: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  args: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      data: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          startTime: Schema.optional(Schema.Number),
          timeDeltas: Schema.optional(Schema.Array(Schema.Number)),
          cpuProfile: Schema.optional(
            Schema.Struct({
              nodes: Schema.optional(Schema.Array(ProfileNode)),
              samples: Schema.optional(Schema.Array(Schema.Number)),
            }),
          ),
        }),
      ),
      beginData: Schema.optional(
        Schema.Struct({ stackTrace: Schema.optional(Schema.Array(StackFrame)) }),
      ),
    }),
  ),
});
export type TraceEvent = typeof TraceEvent.Type;
export const Trace = Schema.Union([
  Schema.Struct({ traceEvents: Schema.Array(TraceEvent) }),
  Schema.Array(TraceEvent),
]);

/** Where a 0-based generated position came from, or undefined outside the build's sourcemaps. */
export type SourceMapper = (
  url: string,
  line: number,
  column: number,
) => { readonly source: string; readonly line: number } | undefined;

/**
 * Steps are marked in the page with `performance.mark(MARK_PREFIX + label)` before their input,
 * and `MARK_PREFIX + END_LABEL` once they settled.
 */
export const MARK_PREFIX = "client-metrics:";
export const END_LABEL = "end";
/** The longest a step is watched after its mark, when no end mark closes it sooner. */
export const STEP_WINDOW_MS = 1_500;
const LONG_TASK_MS = 50;
const INPUT_EVENTS = new Set(["click", "keydown", "wheel"]);
/** Every sample sits under these; counting them inclusively says nothing. */
const WRAPPERS = /^(nm:react-dom|nm:scheduler|\(root\)|\(program\)|\(idle\))/;

const Weighted = Schema.Struct({ name: Schema.String, ms: Schema.Number });
export type Weighted = typeof Weighted.Type;
const LongTask = Schema.Struct({
  /** From the step's mark to the task's start. */
  atMs: Schema.Number,
  ms: Schema.Number,
  top: Schema.Array(Weighted),
});
export const TraceStep = Schema.Struct({
  label: Schema.String,
  /** Marked windows of this label in the traced round; the times below are per window. */
  windows: Schema.Number,
  /** The task that ran the step's first click, keydown or wheel event. */
  inputTaskMs: Schema.Number,
  /** Style recalculation and layout a script forced inside the input task. */
  forcedStyleMs: Schema.Number,
  forcedLayoutMs: Schema.Number,
  /** Median of each window's style plus layout, which the two medians above can both miss. */
  forcedMs: Schema.optional(Schema.Number),
  /** CPU samples inside the input task. */
  sampledMs: Schema.Number,
  /** Self time by package (app package, `nm:` library or V8 bucket); sums to `sampledMs`. */
  selfByPackage: Schema.Array(Weighted),
  /** Inclusive time by original source file, each file counted once per sample. */
  bySource: Schema.Array(Weighted),
  /** Inclusive time by library, each counted once per sample however deep it nests. */
  byPackage: Schema.Array(Weighted),
  /** Tasks over 50 ms after the input task (anywhere in the window without one), with their top sources. */
  longTasks: Schema.Array(LongTask),
});
export type TraceStep = typeof TraceStep.Type;
export const CallSite = Schema.Struct({
  site: Schema.String,
  ms: Schema.Number,
  count: Schema.Number,
});
export type CallSite = typeof CallSite.Type;

/** `nm:react-dom/cjs/x.js` → `nm:react-dom`; `apps/web/src/x.tsx` → `apps/web`. */
export function packageOf(source: string) {
  if (source.startsWith("nm:")) {
    const parts = source.slice(3).split("/");
    return `nm:${parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]}`;
  }
  const match = /^(apps|packages)\/[^/]+/.exec(source);
  return match ? match[0] : source;
}

/** A sourcemapped path as a short, stable name: libraries as `nm:<path in the package>`. */
export function normalizeSource(source: string) {
  if (source.includes("node_modules/")) {
    return `nm:${source
      .split("node_modules/")
      .pop()!
      .replace(/^\.pnpm\/[^/]+\/node_modules\//, "")}`;
  }
  return source;
}

interface Thread {
  readonly events: ReadonlyArray<TraceEvent>;
  readonly pid: number;
  readonly tid: number;
}

/** The renderer main thread with the most events: the page's. */
function mainThread(events: ReadonlyArray<TraceEvent>): Thread | undefined {
  const names = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (event.ph === "M" && event.name === "thread_name" && event.args?.name !== undefined) {
      names.set(key, event.args.name);
    }
  }
  const key = [...counts]
    .filter(([entry]) => names.get(entry) === "CrRendererMain")
    .toSorted((a, b) => b[1] - a[1])[0]?.[0];
  if (key === undefined) return undefined;
  const [pid, tid] = key.split(":").map(Number);
  return {
    pid: pid!,
    tid: tid!,
    events: events.filter((event) => `${event.pid}:${event.tid}` === key && event.ts !== undefined),
  };
}

interface Profile {
  readonly frames: ReadonlyMap<number, typeof CallFrame.Type>;
  readonly parents: ReadonlyMap<number, number>;
  /** [timestamp µs, node id], in time order. */
  readonly samples: ReadonlyArray<readonly [number, number]>;
}

/** The main thread's CPU profile, stitched from its chunks; empty without the profiler category. */
export function cpuProfile(events: ReadonlyArray<TraceEvent>, thread: Thread): Profile {
  const byId = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (event.pid !== thread.pid || event.id === undefined) continue;
    if (event.name !== "Profile" && event.name !== "ProfileChunk") continue;
    const id = String(event.id);
    byId.set(id, [...(byId.get(id) ?? []), event]);
  }
  // A page can have worker profiles too; only one started on the main thread is its.
  const chunks = [...byId.values()].find((entries) =>
    entries.some((entry) => entry.name === "Profile" && entry.tid === thread.tid),
  );
  const frames = new Map<number, typeof CallFrame.Type>();
  const parents = new Map<number, number>();
  const samples: Array<readonly [number, number]> = [];
  let ts = 0;
  for (const chunk of chunks ?? []) {
    const data = chunk.args?.data;
    if (chunk.name === "Profile") {
      ts = data?.startTime ?? ts;
      continue;
    }
    for (const node of data?.cpuProfile?.nodes ?? []) {
      frames.set(node.id, node.callFrame);
      if (node.parent !== undefined) parents.set(node.id, node.parent);
    }
    const deltas = data?.timeDeltas ?? [];
    (data?.cpuProfile?.samples ?? []).forEach((id, index) => {
      ts += deltas[index] ?? 0;
      samples.push([ts, id]);
    });
  }
  samples.sort((a, b) => a[0] - b[0]);
  return { frames, parents, samples };
}

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const top = (totals: ReadonlyMap<string, number>, count: number, per = 1): Weighted[] =>
  [...totals]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name, ms]) => ({ name, ms: round(ms / per, 1) }));

const add = (totals: Map<string, number>, key: string, ms: number) =>
  totals.set(key, (totals.get(key) ?? 0) + ms);

/**
 * Each marked step's input task, forced style/layout, CPU by source and later long tasks, plus the
 * top forced call sites. Style or layout with a JS stack was forced mid-task. `skipCases` windows
 * (label before the colon) still bound their neighbours but count nowhere.
 */
export function analyzeTrace(
  events: ReadonlyArray<TraceEvent>,
  mapper: SourceMapper,
  options: {
    readonly topSites?: number;
    readonly topEntries?: number;
    readonly skipCases?: ReadonlySet<string>;
  } = {},
) {
  const thread = mainThread(events);
  if (thread === undefined) return undefined;
  const topEntries = options.topEntries ?? 8;
  const onMain = thread.events;
  const profile = cpuProfile(events, thread);
  const labelCache = new Map<number, string>();
  const sourceOf = (id: number) => {
    const cached = labelCache.get(id);
    if (cached !== undefined) return cached;
    const frame = profile.frames.get(id);
    let label = `(${frame?.functionName || "native"})`.replace(/^\(\((.*)\)\)$/, "($1)");
    if (frame?.url) {
      const mapped = mapper(frame.url, frame.lineNumber ?? 0, frame.columnNumber ?? 0);
      label = mapped
        ? normalizeSource(mapped.source)
        : `(unmapped) ${frame.url.split("/").pop()?.split("?")[0]}`;
    }
    labelCache.set(id, label);
    return label;
  };
  const sampleWeights = (start: number, end: number) => {
    const out: Array<readonly [number, number]> = [];
    const { samples } = profile;
    let low = 0;
    let high = samples.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (samples[middle]![0] < start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < samples.length - 1; index++) {
      const [ts, id] = samples[index]!;
      if (ts > end) break;
      out.push([id, Math.min(samples[index + 1]![0] - ts, 2_000) / 1_000]);
    }
    return out;
  };
  const stackOf = (id: number) => {
    const stack: string[] = [];
    for (let node: number | undefined = id; node !== undefined; node = profile.parents.get(node)) {
      stack.push(sourceOf(node));
    }
    return stack;
  };

  const marks = new Map<string, { label: string; ts: number }>();
  for (const event of onMain) {
    if (!event.name?.startsWith(MARK_PREFIX)) continue;
    marks.set(`${event.name}@${event.ts}`, {
      label: event.name.slice(MARK_PREFIX.length),
      ts: event.ts!,
    });
  }
  const ordered = [...marks.values()].toSorted((a, b) => a.ts - b.ts);
  const starts = ordered.filter(
    (mark) => mark.label !== END_LABEL && !options.skipCases?.has(mark.label.split(":")[0]!),
  );
  const tasks = onMain.filter((event) => event.name === "RunTask" && event.ph === "X");
  const taskAt = (at: number) =>
    tasks.find((task) => task.ts! <= at && task.ts! + (task.dur ?? 0) >= at);
  const sites = new Map<string, { ms: number; count: number }>();

  interface Window {
    inputTaskMs: number;
    style: number;
    layout: number;
    sampled: number;
    self: Map<string, number>;
    bySource: Map<string, number>;
    byPackage: Map<string, number>;
    longTasks: Array<typeof LongTask.Type>;
  }
  const windows = new Map<string, Window[]>();
  for (const mark of starts) {
    const next = ordered.find((candidate) => candidate.ts > mark.ts);
    const end = Math.min(next?.ts ?? Infinity, mark.ts + STEP_WINDOW_MS * 1_000);
    const input = onMain.find(
      (event) =>
        event.name === "EventDispatch" &&
        event.ts! >= mark.ts &&
        event.ts! < end &&
        INPUT_EVENTS.has(event.args?.data?.type ?? ""),
    );
    const task = input === undefined ? undefined : taskAt(input.ts!);
    const window: Window = {
      inputTaskMs: 0,
      style: 0,
      layout: 0,
      sampled: 0,
      self: new Map(),
      bySource: new Map(),
      byPackage: new Map(),
      longTasks: [],
    };
    if (task !== undefined) {
      const start = task.ts!;
      const stop = start + (task.dur ?? 0);
      window.inputTaskMs = (task.dur ?? 0) / 1_000;
      for (const event of onMain) {
        if (event.ph !== "X" || event.ts! < start || event.ts! > stop) continue;
        if (event.name !== "UpdateLayoutTree" && event.name !== "Layout") continue;
        // Frames without a URL are the harness's own injected scripts (Playwright's hit tests).
        const stack = event.args?.beginData?.stackTrace ?? [];
        if (!stack.some((frame) => frame.url !== "")) continue;
        const ms = (event.dur ?? 0) / 1_000;
        if (event.name === "Layout") window.layout += ms;
        else window.style += ms;
        const site =
          stack
            .slice(0, 6)
            .map((frame) => {
              const mapped = mapper(frame.url, frame.lineNumber - 1, frame.columnNumber - 1);
              return mapped
                ? `${normalizeSource(mapped.source)}:${mapped.line + 1}`
                : `${frame.functionName || "(anonymous)"}@${frame.url.split("/").pop()}`;
            })
            .filter((entry, position, all) => all.indexOf(entry) === position)
            .slice(0, 3)
            .join(" < ") || "(frame)";
        const current = sites.get(site) ?? { ms: 0, count: 0 };
        sites.set(site, { ms: current.ms + ms, count: current.count + 1 });
      }
      for (const [id, ms] of sampleWeights(start, stop)) {
        window.sampled += ms;
        const stack = stackOf(id);
        add(window.self, packageOf(stack[0]!), ms);
        for (const source of new Set(stack)) {
          if (!WRAPPERS.test(source)) add(window.bySource, source, ms);
        }
        for (const name of new Set(stack.map(packageOf))) {
          if (!WRAPPERS.test(name)) add(window.byPackage, name, ms);
        }
      }
    }
    const after = task === undefined ? mark.ts : task.ts! + (task.dur ?? 0);
    for (const later of tasks) {
      if (later === task || later.ts! < after || later.ts! >= end) continue;
      if ((later.dur ?? 0) / 1_000 < LONG_TASK_MS) continue;
      const totals = new Map<string, number>();
      for (const [id, ms] of sampleWeights(later.ts!, later.ts! + (later.dur ?? 0))) {
        for (const source of new Set(stackOf(id))) {
          if (!WRAPPERS.test(source)) add(totals, source, ms);
        }
      }
      window.longTasks.push({
        atMs: round((later.ts! - mark.ts) / 1_000, 0),
        ms: round((later.dur ?? 0) / 1_000, 1),
        top: top(totals, 4),
      });
    }
    windows.set(mark.label, [...(windows.get(mark.label) ?? []), window]);
  }

  const steps: TraceStep[] = [...windows].map(([label, entries]) => {
    const merged = (pick: (window: Window) => Map<string, number>) => {
      const totals = new Map<string, number>();
      for (const window of entries) for (const [key, ms] of pick(window)) add(totals, key, ms);
      return totals;
    };
    return {
      label,
      windows: entries.length,
      inputTaskMs: round(median(entries.map((entry) => entry.inputTaskMs)), 1),
      forcedStyleMs: round(median(entries.map((entry) => entry.style)), 1),
      forcedLayoutMs: round(median(entries.map((entry) => entry.layout)), 1),
      forcedMs: round(median(entries.map((entry) => entry.style + entry.layout)), 1),
      sampledMs: round(median(entries.map((entry) => entry.sampled)), 1),
      selfByPackage: top(
        merged((window) => window.self),
        topEntries,
        entries.length,
      ),
      bySource: top(
        merged((window) => window.bySource),
        topEntries,
        entries.length,
      ),
      byPackage: top(
        merged((window) => window.byPackage),
        topEntries,
        entries.length,
      ),
      longTasks: entries
        .flatMap((entry) => entry.longTasks)
        .toSorted((a, b) => b.ms - a.ms)
        .slice(0, 3),
    };
  });
  const callSites: CallSite[] = [...sites]
    .toSorted((a, b) => b[1].ms - a[1].ms)
    .slice(0, options.topSites ?? 12)
    .map(([site, { ms, count }]) => ({ site, ms: round(ms, 1), count }));
  return { steps, callSites, profiled: profile.samples.length > 0 };
}
