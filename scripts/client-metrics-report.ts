// The pure half of scripts/client-metrics.ts: the JSON it writes, its tables, how two compare, and
// what a Chromium trace says about forced style and layout inside a click.
import * as Schema from "effect/Schema";

import { bootstrapMedianDifference, MachineState, round } from "./server-metrics-report.ts";

/** Every case the benchmark can switch to, in the order it visits them. */
export const CASES = [
  "short",
  "long",
  "working",
  "approval",
  "medium",
  "diff",
  "pull-request",
  "browser",
  "device",
] as const;
export type Case = (typeof CASES)[number];

const Switch = Schema.Struct({
  case: Schema.String,
  visit: Schema.Literals(["first", "revisit"]),
  round: Schema.Number,
  /** Click to the next paint: the Event Timing entry's duration; null when under 16 ms. */
  paintMs: Schema.NullOr(Schema.Number),
  /** Click to the first frame that showed the new thread's timeline rows. */
  contentMs: Schema.NullOr(Schema.Number),
  /** Whether that frame was the first one painted on the new route. */
  firstFrameContent: Schema.Boolean,
  /** Summed long-animation-frame duration in the 1.5 s after the click. */
  loafMs: Schema.Number,
});
export type Switch = typeof Switch.Type;

const Forced = Schema.Struct({
  case: Schema.String,
  clickTaskMs: Schema.Number,
  /** Style recalculation and layout a script forced inside the click's task. */
  forcedStyleMs: Schema.Number,
  forcedLayoutMs: Schema.Number,
});
export type Forced = typeof Forced.Type;

const Memory = Schema.Struct({
  label: Schema.String,
  heapMB: Schema.Number,
  domNodes: Schema.Number,
  listeners: Schema.Number,
});
export type Memory = typeof Memory.Type;

const Idle = Schema.Struct({
  label: Schema.String,
  seconds: Schema.Number,
  /** Renderer main-thread busy time as a share of the window, from CDP Performance metrics. */
  taskPct: Schema.Number,
  scriptPct: Schema.Number,
  stylePct: Schema.Number,
  layoutPct: Schema.Number,
});
export type Idle = typeof Idle.Type;

const Run = Schema.Struct({
  switches: Schema.Array(Switch),
  memory: Schema.Array(Memory),
  idle: Schema.Array(Idle),
  forced: Schema.optional(Schema.Array(Forced)),
  machine: Schema.optional(MachineState),
});
export type Run = typeof Run.Type;

const CallSite = Schema.Struct({ site: Schema.String, ms: Schema.Number, count: Schema.Number });
export type CallSite = typeof CallSite.Type;

export const ClientMetrics = Schema.Struct({
  meta: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  runs: Schema.Array(Run),
  /** Top call sites of forced style and layout in click tasks, from the last traced run. */
  callSites: Schema.optional(Schema.Array(CallSite)),
});
export type ClientMetrics = typeof ClientMetrics.Type;

/** The cases a `--cases` list names, in benchmark order; an error names unknown ones. */
export function parseCases(list: string): { cases: ReadonlyArray<Case> } | { error: string } {
  const named = list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (named.length === 0) return { cases: CASES };
  const unknown = named.filter((entry) => !(CASES as ReadonlyArray<string>).includes(entry));
  if (unknown.length > 0) {
    return { error: `unknown cases: ${unknown.join(", ")}; choose from ${CASES.join(", ")}` };
  }
  return { cases: CASES.filter((entry) => named.includes(entry)) };
}

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

const present = (values: ReadonlyArray<number | null>) =>
  values.filter((value): value is number => value !== null);

/**
 * Every compared metric of a file, each with one value per sample: per switch for latencies, per
 * run for shares, memory and idle CPU.
 */
export function flatten(metrics: ClientMetrics): Map<string, number[]> {
  const values = new Map<string, number[]>();
  const add = (key: string, value: number | null) => {
    if (value === null || !Number.isFinite(value)) return;
    values.set(key, [...(values.get(key) ?? []), value]);
  };
  for (const run of metrics.runs) {
    const groups = new Map<string, Switch[]>();
    for (const entry of run.switches) {
      const key = `switch.${entry.case}.${entry.visit}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
      add(`${key}.paintMs`, entry.paintMs);
      add(`${key}.contentMs`, entry.contentMs);
      add(`${key}.loafMs`, entry.loafMs);
    }
    for (const [key, entries] of groups) {
      const missed = entries.filter((entry) => !entry.firstFrameContent).length;
      add(`${key}.firstFrameMissPct`, (missed / entries.length) * 100);
    }
    for (const entry of run.forced ?? []) {
      add(`forced.${entry.case}.styleLayoutMs`, entry.forcedStyleMs + entry.forcedLayoutMs);
    }
    for (const entry of run.memory) {
      add(`memory.${entry.label}.heapMB`, entry.heapMB);
      add(`memory.${entry.label}.domNodes`, entry.domNodes);
    }
    for (const entry of run.idle) add(`idle.${entry.label}.taskPct`, entry.taskPct);
  }
  return values;
}

/** The absolute change a metric must clear, past the relative threshold, to count. */
export function floorFor(metric: string) {
  if (metric.endsWith("Ms")) return 8;
  if (metric.endsWith("MissPct")) return 20;
  if (metric.endsWith("taskPct")) return 1;
  if (metric.endsWith("heapMB")) return 3;
  if (metric.endsWith("domNodes")) return 500;
  return 0;
}

const cell = (value: number | null, digits = 0) =>
  value === null ? "–" : `${round(value, digits)}`;

/** The run's markdown: per case latency, then memory and idle CPU. */
export function summaryTable(metrics: ClientMetrics) {
  const switches = metrics.runs.flatMap((run) => run.switches);
  const forced = metrics.runs.flatMap((run) => run.forced ?? []);
  const lines = [
    "### Client switch metrics (ms, lower is better)",
    "",
    `\`${metrics.meta.commit}\`, ${metrics.runs.length} run(s), ${metrics.meta.platform}, Chromium ${metrics.meta.chromium}`,
    "",
    "| case | visit | n | paint p50 | paint p90 | content p50 | not in 1st frame | LoAF p50 | LoAF p90 | forced style+layout p50 |",
    "| :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: |",
  ];
  const cases = [...new Set(switches.map((entry) => entry.case))];
  for (const name of cases) {
    for (const visit of ["first", "revisit"] as const) {
      const rows = switches.filter((entry) => entry.case === name && entry.visit === visit);
      if (rows.length === 0) continue;
      const paint = present(rows.map((entry) => entry.paintMs));
      const content = present(rows.map((entry) => entry.contentMs));
      const loaf = rows.map((entry) => entry.loafMs);
      const missed = rows.filter((entry) => !entry.firstFrameContent).length;
      const forcedMs =
        visit === "revisit"
          ? forced
              .filter((entry) => entry.case === name)
              .map((entry) => entry.forcedStyleMs + entry.forcedLayoutMs)
          : [];
      lines.push(
        `| ${name} | ${visit} | ${rows.length} | ${cell(median(paint))} | ${cell(percentile(paint, 90))} | ${cell(median(content))} | ${missed}/${rows.length} | ${cell(median(loaf))} | ${cell(percentile(loaf, 90))} | ${cell(median(forcedMs), 1)} |`,
      );
    }
  }
  const memory = metrics.runs.flatMap((run) => run.memory);
  if (memory.length > 0) {
    lines.push(
      "",
      "| memory after GC | heap MB | DOM nodes | listeners |",
      "| :-- | --: | --: | --: |",
    );
    for (const label of new Set(memory.map((entry) => entry.label))) {
      const rows = memory.filter((entry) => entry.label === label);
      lines.push(
        `| ${label} | ${cell(median(rows.map((entry) => entry.heapMB)), 1)} | ${cell(median(rows.map((entry) => entry.domNodes)))} | ${cell(median(rows.map((entry) => entry.listeners)))} |`,
      );
    }
  }
  const idle = metrics.runs.flatMap((run) => run.idle);
  if (idle.length > 0) {
    lines.push(
      "",
      "| renderer CPU while a thread streams | task % | script % | style % | layout % |",
      "| :-- | --: | --: | --: | --: |",
    );
    for (const label of new Set(idle.map((entry) => entry.label))) {
      const rows = idle.filter((entry) => entry.label === label);
      const at = (pick: (entry: Idle) => number) => cell(median(rows.map(pick)), 1);
      lines.push(
        `| ${label} | ${at((entry) => entry.taskPct)} | ${at((entry) => entry.scriptPct)} | ${at((entry) => entry.stylePct)} | ${at((entry) => entry.layoutPct)} |`,
      );
    }
  }
  if (metrics.callSites && metrics.callSites.length > 0) {
    lines.push(
      "",
      "| forced style+layout call site (traced round) | ms | count |",
      "| :-- | --: | --: |",
    );
    for (const site of metrics.callSites) {
      lines.push(`| \`${site.site}\` | ${round(site.ms, 1)} | ${site.count} |`);
    }
  }
  return lines.join("\n");
}

/** Two files' medians side by side; a metric counts when its bootstrap interval clears both bars. */
export function compareClientMetrics(before: ClientMetrics, after: ClientMetrics, threshold = 10) {
  const a = flatten(before);
  const b = flatten(after);
  const lines = [
    "### Client metrics (lower is better)",
    "",
    `before \`${before.meta.commit}\` (${before.runs.length} runs), after \`${after.meta.commit}\` (${after.runs.length} runs)`,
    "",
    "| metric | before | after | change | 95% interval | |",
    "| :-- | --: | --: | --: | --: | :-- |",
  ];
  const regressed: string[] = [];
  const improved: string[] = [];
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
    const mx = median(x)!;
    const my = median(y)!;
    const limit = Math.max(floorFor(metric), (Math.abs(mx) * threshold) / 100);
    const repeated = x.length > 1 && y.length > 1;
    const [low, high] = repeated ? bootstrapMedianDifference(x, y) : [my - mx, my - mx];
    const verdict = low > limit ? "worse" : high < -limit ? "better" : "";
    if (verdict === "worse") regressed.push(metric);
    if (verdict === "better") improved.push(metric);
    const percent = mx === 0 ? (my === 0 ? 0 : Infinity) : ((my - mx) / Math.abs(mx)) * 100;
    const shown = Number.isFinite(percent)
      ? `${percent > 0 ? "+" : ""}${Math.round(percent)}%`
      : "new";
    const interval = repeated ? `${round(low, 1)} to ${round(high, 1)}` : "";
    lines.push(
      `| ${metric} | ${round(mx, 1)} | ${round(my, 1)} | ${shown} | ${interval} | ${verdict} |`,
    );
  }
  return { table: lines.join("\n"), regressed, improved, compared };
}

const StackFrame = Schema.Struct({
  url: Schema.String,
  functionName: Schema.optional(Schema.String),
  lineNumber: Schema.Number,
  columnNumber: Schema.Number,
});
export const TraceEvent = Schema.Struct({
  name: Schema.optional(Schema.String),
  ph: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  tid: Schema.optional(Schema.Number),
  ts: Schema.optional(Schema.Number),
  dur: Schema.optional(Schema.Number),
  args: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      data: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
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

/** Maps a 0-based generated position to `file:line`, or undefined outside the build's sourcemaps. */
export type SourceMapper = (url: string, line: number, column: number) => string | undefined;

/**
 * Forced style and layout inside each click's task, the clicks labelled in order. A style or
 * layout event with a JS stack was forced by a script reading layout mid-task; one without ran in
 * the frame's own rendering step. Returns undefined when the trace's clicks do not match `labels`.
 */
export function analyzeClickTasks(
  events: ReadonlyArray<TraceEvent>,
  labels: ReadonlyArray<string>,
  mapper: SourceMapper,
  topSites = 12,
) {
  const names = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (event.ph === "M" && event.name === "thread_name" && event.args?.name !== undefined) {
      names.set(key, event.args.name);
    }
  }
  const main = [...counts]
    .filter(([key]) => names.get(key) === "CrRendererMain")
    .toSorted((a, b) => b[1] - a[1])[0]?.[0];
  if (main === undefined) return undefined;
  const onMain = events.filter(
    (event) => `${event.pid}:${event.tid}` === main && event.ts !== undefined,
  );
  const clicks = onMain.filter(
    (event) => event.name === "EventDispatch" && event.args?.data?.type === "click",
  );
  if (clicks.length !== labels.length) return undefined;
  const tasks = onMain.filter((event) => event.name === "RunTask" && event.ph === "X");
  const sites = new Map<string, { ms: number; count: number }>();
  const perClick = clicks.flatMap((click, index) => {
    const at = click.ts ?? 0;
    const task = tasks.find(
      (candidate) => (candidate.ts ?? 0) <= at && (candidate.ts ?? 0) + (candidate.dur ?? 0) >= at,
    );
    if (task === undefined) return [];
    const start = task.ts ?? 0;
    const end = start + (task.dur ?? 0);
    let style = 0;
    let layout = 0;
    for (const event of onMain) {
      if (event.ph !== "X" || (event.ts ?? 0) < start || (event.ts ?? 0) > end) continue;
      if (event.name !== "UpdateLayoutTree" && event.name !== "Layout") continue;
      const stack = event.args?.beginData?.stackTrace ?? [];
      if (stack.length === 0) continue;
      const ms = (event.dur ?? 0) / 1000;
      if (event.name === "Layout") layout += ms;
      else style += ms;
      const site =
        stack
          .slice(0, 6)
          .map(
            (frame) =>
              mapper(frame.url, frame.lineNumber - 1, frame.columnNumber - 1) ??
              `${frame.functionName || "(anonymous)"}@${frame.url.split("/").pop()}`,
          )
          .filter((entry, position, all) => all.indexOf(entry) === position)
          .slice(0, 3)
          .join(" < ") || "(frame)";
      const current = sites.get(site) ?? { ms: 0, count: 0 };
      sites.set(site, { ms: current.ms + ms, count: current.count + 1 });
    }
    const forced: Forced = {
      case: labels[index]!,
      clickTaskMs: round((task.dur ?? 0) / 1000, 1),
      forcedStyleMs: round(style, 1),
      forcedLayoutMs: round(layout, 1),
    };
    return [forced];
  });
  const callSites: CallSite[] = [...sites]
    .toSorted((a, b) => b[1].ms - a[1].ms)
    .slice(0, topSites)
    .map(([site, { ms, count }]) => ({ site, ms: round(ms, 1), count }));
  return { perClick, callSites };
}
