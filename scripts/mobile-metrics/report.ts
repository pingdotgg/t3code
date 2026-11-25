// The pure half of scripts/mobile-metrics.ts: what one probe window measured, the JSON a run
// writes, its tables, and the series `compare` and `noise` share with client-metrics.
import * as Schema from "effect/Schema";

import { median, percentile, topCounts } from "../client-metrics-report.ts";
import { frameStats } from "../mobile-behavior/grade.ts";
import { MachineState, round } from "../server-metrics-report.ts";

/** One perf window as the probe's `perfStop` returns it (see behavior-probe.ts). */
export interface PerfWindow {
  readonly startedAt: number;
  readonly inputs: ReadonlyArray<{ readonly kind: string; readonly at: number }>;
  readonly commits: ReadonlyArray<{ readonly at: number; readonly ms: number }>;
  readonly content: ReadonlyArray<{
    readonly thread: string;
    readonly at: number;
    readonly frameAt: number | null;
  }>;
  readonly keys: ReadonlyArray<number>;
  readonly js: ReadonlyArray<number>;
  readonly ui: ReadonlyArray<number>;
  readonly renders: {
    readonly commits: number;
    readonly totalRenders: number;
    readonly components: ReadonlyArray<{ readonly key: string; readonly count: number }>;
    readonly causes: ReadonlyArray<{ readonly key: string; readonly count: number }>;
  } | null;
  readonly heapBytes: number | null;
}

const Count = Schema.Struct({ name: Schema.String, count: Schema.Number });
const Renders = Schema.Struct({
  commits: Schema.Number,
  renders: Schema.Number,
  top: Schema.Array(Count),
  causes: Schema.Array(Count),
});

const Step = Schema.Struct({
  case: Schema.String,
  step: Schema.String,
  /** A thread's first open in this app launch, or a later one; other steps say `step`. */
  visit: Schema.Literals(["first", "revisit", "step"]),
  round: Schema.Number,
  /** Input to the frame after the commit that showed the target thread's rows. */
  contentMs: Schema.NullOr(Schema.Number),
  /** Input to the last React commit before the app went quiet. */
  settledMs: Schema.NullOr(Schema.Number),
  commits: Schema.Number,
  /** Render work React timed in those commits (development builds only). */
  commitMs: Schema.Number,
  jsDroppedPct: Schema.NullOr(Schema.Number),
  jsMaxFrameMs: Schema.NullOr(Schema.Number),
  uiDroppedPct: Schema.NullOr(Schema.Number),
  uiMaxFrameMs: Schema.NullOr(Schema.Number),
  /** Composer key to the next JS frame, for typing steps. */
  keyP50Ms: Schema.NullOr(Schema.Number),
  keyP90Ms: Schema.NullOr(Schema.Number),
  renders: Schema.optional(Renders),
});
export type Step = typeof Step.Type;

const Memory = Schema.Struct({
  label: Schema.String,
  /** Hermes heap after a collection. */
  heapMB: Schema.NullOr(Schema.Number),
  /** The app process's footprint from agent-device (`perf memory sample`). */
  processMB: Schema.NullOr(Schema.Number),
});
export type Memory = typeof Memory.Type;

const Run = Schema.Struct({
  steps: Schema.Array(Step),
  memory: Schema.Array(Memory),
  skipped: Schema.optional(
    Schema.Array(Schema.Struct({ case: Schema.String, reason: Schema.String })),
  ),
  machine: Schema.optional(MachineState),
});
export type Run = typeof Run.Type;

export const MobileMetrics = Schema.Struct({
  meta: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  runs: Schema.Array(Run),
});
export type MobileMetrics = typeof MobileMetrics.Type;

/** Settings that change what shared metrics measure. */
export const WORKLOAD_KEYS = ["cases", "rounds", "longTurns", "device"] as const;
/** Settings that change timing without changing the workload. */
export const PROBE_KEYS = ["renders"] as const;

/** The first touch's end, else its start: where a tap's latency counts from. */
export function inputAt(window: Pick<PerfWindow, "inputs">) {
  const end = window.inputs.find((input) => input.kind === "touch-end");
  return (end ?? window.inputs.find((input) => input.kind === "touch-start"))?.at ?? null;
}

/**
 * One step's metrics from its window. `thread` names the thread whose rows count as content;
 * commits before the input belong to the harness's own calls, so they are left out.
 */
export function stepOf(
  window: PerfWindow,
  step: Pick<Step, "case" | "step" | "visit" | "round">,
  thread: string | null,
): Step {
  const keyed = window.keys.length > 0;
  const from = keyed ? window.inputs.find((input) => input.kind === "key")?.at : inputAt(window);
  const start = from ?? window.startedAt;
  const commits = window.commits.filter((commit) => commit.at >= start);
  const shown = thread
    ? window.content.find((entry) => entry.thread.endsWith(thread) && entry.at >= start)
    : undefined;
  const since = (at: number | null | undefined) =>
    from === undefined || from === null || at === null || at === undefined
      ? null
      : round(Math.max(0, at - from), 0);
  const frames = (timestamps: ReadonlyArray<number>, prefix: "js" | "ui") => {
    const stats = frameStats(
      timestamps.filter((at) => at >= start),
      prefix,
    );
    const dropped = stats[`${prefix}DroppedPct`];
    const max = stats[`${prefix}MaxMs`];
    return {
      dropped: typeof dropped === "number" ? dropped : null,
      max: typeof max === "number" ? max : null,
    };
  };
  const js = frames(window.js, "js");
  const ui = frames(window.ui, "ui");
  const keys = window.keys.toSorted((a, b) => a - b);
  return {
    ...step,
    contentMs: since(shown?.frameAt),
    settledMs: since(commits.at(-1)?.at),
    commits: commits.length,
    commitMs: round(
      commits.reduce((sum, commit) => sum + commit.ms, 0),
      0,
    ),
    jsDroppedPct: js.dropped,
    jsMaxFrameMs: js.max,
    uiDroppedPct: ui.dropped,
    uiMaxFrameMs: ui.max,
    keyP50Ms: keys.length ? round(median(keys)!, 1) : null,
    keyP90Ms: keys.length ? round(percentile(keys, 90)!, 1) : null,
    ...(window.renders
      ? {
          renders: {
            commits: window.renders.commits,
            renders: window.renders.totalRenders,
            top: window.renders.components
              .slice(0, 8)
              .map(({ key, count }) => ({ name: key, count })),
            causes: window.renders.causes
              .slice(0, 8)
              .map(({ key, count }) => ({ name: key, count })),
          },
        }
      : {}),
  };
}

const NUMERIC = [
  "contentMs",
  "settledMs",
  "commits",
  "commitMs",
  "jsDroppedPct",
  "jsMaxFrameMs",
  "uiDroppedPct",
  "uiMaxFrameMs",
  "keyP50Ms",
  "keyP90Ms",
] as const;

/** Every compared metric, one value per run: the median of the run's samples of it. */
export function flatten(metrics: MobileMetrics): Map<string, number[]> {
  const values = new Map<string, number[]>();
  for (const run of metrics.runs) {
    const inRun = new Map<string, number[]>();
    const add = (key: string, value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      inRun.set(key, [...(inRun.get(key) ?? []), value]);
    };
    for (const entry of run.steps) {
      const key = `${entry.case}.${entry.step}${entry.visit === "step" ? "" : `.${entry.visit}`}`;
      for (const field of NUMERIC) add(`${key}.${field}`, entry[field]);
      add(`${key}.renders`, entry.renders?.renders);
    }
    for (const entry of run.memory) {
      add(`memory.${entry.label}.heapMB`, entry.heapMB);
      add(`memory.${entry.label}.processMB`, entry.processMB);
    }
    for (const [key, samples] of inRun)
      values.set(key, [...(values.get(key) ?? []), median(samples)!]);
  }
  return values;
}

/** Settings two files disagree on, and those one of them did not record. */
export function workloadDifferences(
  before: MobileMetrics,
  after: MobileMetrics,
  keys: ReadonlyArray<string> = WORKLOAD_KEYS,
) {
  const differ: string[] = [];
  const unrecorded: string[] = [];
  for (const key of keys) {
    const a = before.meta[key];
    const b = after.meta[key];
    if (a === undefined || b === undefined) {
      if (a !== b) unrecorded.push(key);
    } else if (a !== b) differ.push(`${key} ${a} vs ${b}`);
  }
  return { differ, unrecorded };
}

const cell = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? "–" : `${round(value, digits)}`;
const present = (values: ReadonlyArray<number | null>) =>
  values.filter((value): value is number => value !== null);
const listOf = (entries: ReadonlyArray<{ readonly name: string; readonly count: number }>) =>
  entries.map((entry) => `${entry.name} ${entry.count}`).join(", ") || "–";

/** The run's markdown: per step latency and frames, renders, memory. */
export function summaryTable(metrics: MobileMetrics) {
  const steps = metrics.runs.flatMap((run) => run.steps);
  const lines = [
    "### Mobile metrics (ms, lower is better)",
    "",
    `\`${metrics.meta.commit}\`, ${metrics.runs.length} run(s), ${metrics.meta.device}, ${metrics.meta.build} build`,
  ];
  const keys = [
    ...new Set(steps.map((entry) => `${entry.case}\u0000${entry.step}\u0000${entry.visit}`)),
  ];
  if (keys.length > 0) {
    lines.push(
      "",
      "| case | step | visit | n | content p50 | content p90 | settled p50 | settled p90 | commits p50 | commit ms p50 | JS dropped % p50 | JS max frame p50 | UI dropped % p50 | key p50 |",
      "| :-- | :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
    );
    for (const key of keys) {
      const [name, step, visit] = key.split("\u0000") as [string, string, string];
      const rows = steps.filter(
        (entry) => entry.case === name && entry.step === step && entry.visit === visit,
      );
      const pick = (field: (typeof NUMERIC)[number]) => present(rows.map((entry) => entry[field]));
      lines.push(
        `| ${name} | ${step} | ${visit === "step" ? "" : visit} | ${rows.length} | ${cell(median(pick("contentMs")))} | ${cell(percentile(pick("contentMs"), 90))} | ${cell(median(pick("settledMs")))} | ${cell(percentile(pick("settledMs"), 90))} | ${cell(median(pick("commits")))} | ${cell(median(pick("commitMs")))} | ${cell(median(pick("jsDroppedPct")), 1)} | ${cell(median(pick("jsMaxFrameMs")))} | ${cell(median(pick("uiDroppedPct")), 1)} | ${cell(median(pick("keyP50Ms")), 1)} |`,
      );
    }
  }
  const rendered = steps.filter((entry) => entry.renders !== undefined);
  if (rendered.length > 0) {
    lines.push(
      "",
      "| renders per step | n | renders p50 | top components (mean per step) | top causes |",
      "| :-- | --: | --: | :-- | :-- |",
    );
    for (const key of new Set(rendered.map((entry) => `${entry.case}: ${entry.step}`))) {
      const rows = rendered
        .filter((entry) => `${entry.case}: ${entry.step}` === key)
        .map((entry) => entry.renders!);
      lines.push(
        `| ${key} | ${rows.length} | ${cell(median(rows.map((entry) => entry.renders)))} | ${listOf(topCounts(rows.map((entry) => entry.top)))} | ${listOf(
          topCounts(
            rows.map((entry) => entry.causes),
            3,
          ),
        )} |`,
      );
    }
  }
  const memory = metrics.runs.flatMap((run) => run.memory);
  if (memory.length > 0) {
    lines.push("", "| memory | Hermes heap MB | process MB |", "| :-- | --: | --: |");
    for (const label of new Set(memory.map((entry) => entry.label))) {
      const rows = memory.filter((entry) => entry.label === label);
      lines.push(
        `| ${label} | ${cell(median(present(rows.map((entry) => entry.heapMB))), 1)} | ${cell(median(present(rows.map((entry) => entry.processMB))), 1)} |`,
      );
    }
  }
  for (const entry of metrics.runs.flatMap((run) => run.skipped ?? []))
    lines.push("", `Skipped ${entry.case}: ${entry.reason}`);
  return lines.join("\n");
}
