// The pure half of client-metrics.ts: the JSON it writes, its tables, how two files
// compare, and the noise floors A/A runs suggest.
import * as Schema from "effect/Schema";

import {
  cell,
  compareSeries,
  Count,
  Floors,
  MachineState,
  median,
  noiseOfSeries,
  percentile,
  round,
  slope,
  SOAK_LEAK,
  topCounts,
} from "../core/report.ts";
import { CallSite, TraceStep } from "./trace.ts";

/** Thread switches: each case is its own thread, switched to from a small hub thread. */
export const SWITCH_CASES = [
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
/** Interactions inside one thread, each a few measured steps. */
export const INTERACTION_CASES = [
  "type-short",
  "type-long",
  "scroll-long",
  "palette",
  "pr-tabs",
  "surfaces",
  "terminal",
  "settings",
] as const;
/** Every case the benchmark can run, in the order it runs them. */
export const CASES = [...SWITCH_CASES, ...INTERACTION_CASES] as const;
export type SwitchCase = (typeof SWITCH_CASES)[number];
export type InteractionCase = (typeof INTERACTION_CASES)[number];
export type Case = (typeof CASES)[number];
export const isSwitchCase = (name: Case): name is SwitchCase =>
  (SWITCH_CASES as ReadonlyArray<string>).includes(name);

/** What React rendered during one step, from the render probe (`--renders`). */
const Renders = Schema.Struct({
  commits: Schema.Number,
  /** Component renders, a bailed-out subtree not counted. */
  renders: Schema.Number,
  top: Schema.Array(Count),
  /** `Component cause`: mount, state#<hook slot>, props:<changed keys>, parent-same-props<-Parent or context. */
  causes: Schema.Array(Count),
});
export type Renders = typeof Renders.Type;

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
  renders: Schema.optional(Renders),
});
export type Switch = typeof Switch.Type;

const Step = Schema.Struct({
  case: Schema.String,
  step: Schema.String,
  round: Schema.Number,
  /** Input to next paint: the step's slowest Event Timing entry; null when under 16 ms or none. */
  paintMs: Schema.NullOr(Schema.Number),
  /** Summed long-animation-frame duration while the step was watched. */
  loafMs: Schema.Number,
  /** Share of 60 Hz frames the page missed while the step was watched. */
  droppedPct: Schema.Number,
  renders: Schema.optional(Renders),
});
export type Step = typeof Step.Type;

/** DOM a panel case's surface holds once open: deterministic, so a cheap gate on panel weight. */
const Panel = Schema.Struct({
  case: Schema.String,
  panelNodes: Schema.Number,
  documentNodes: Schema.Number,
});
export type Panel = typeof Panel.Type;

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

const SoakSample = Schema.Struct({
  iteration: Schema.Number,
  heapMB: Schema.Number,
  domNodes: Schema.Number,
  listeners: Schema.Number,
});
export type SoakSample = typeof SoakSample.Type;

const Run = Schema.Struct({
  switches: Schema.Array(Switch),
  steps: Schema.optional(Schema.Array(Step)),
  panels: Schema.optional(Schema.Array(Panel)),
  memory: Schema.Array(Memory),
  idle: Schema.Array(Idle),
  trace: Schema.optional(Schema.Array(TraceStep)),
  /** Memory after GC while every case repeats (`--soak`). */
  soak: Schema.optional(Schema.Array(SoakSample)),
  /** Cases this checkout could not run, and why. */
  skipped: Schema.optional(
    Schema.Array(Schema.Struct({ case: Schema.String, reason: Schema.String })),
  ),
  machine: Schema.optional(MachineState),
});
export type Run = typeof Run.Type;

export const ClientMetrics = Schema.Struct({
  meta: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  runs: Schema.Array(Run),
  /** Top call sites of forced style and layout in input tasks, from the last traced run. */
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
  const groups: Record<string, ReadonlyArray<Case>> = {
    switches: SWITCH_CASES,
    interactions: INTERACTION_CASES,
  };
  const unknown = named.filter(
    (entry) => !(CASES as ReadonlyArray<string>).includes(entry) && !Object.hasOwn(groups, entry),
  );
  if (unknown.length > 0) {
    return {
      error: `unknown cases: ${unknown.join(", ")}; choose from switches, interactions, ${CASES.join(", ")}`,
    };
  }
  const chosen = new Set(
    named.flatMap((entry): ReadonlyArray<string> =>
      Object.hasOwn(groups, entry) ? groups[entry]! : [entry],
    ),
  );
  return { cases: CASES.filter((entry) => chosen.has(entry)) };
}

const present = (values: ReadonlyArray<number | null>) =>
  values.filter((value): value is number => value !== null);

/**
 * Growth per iteration over a soak's later half. Warm-up (caches filling, code compiling) slows
 * down as it settles while a leak keeps its rate, so the later half keeps a leak and drops warm-up.
 */
export function soakSlopes(samples: ReadonlyArray<SoakSample>) {
  const last = samples.at(-1)?.iteration ?? 0;
  const settled = samples.filter((sample) => sample.iteration >= last / 2);
  const fit = (pick: (sample: SoakSample) => number) =>
    slope(settled.map((sample) => [sample.iteration, pick(sample)] as const));
  return {
    heapMB: fit((sample) => sample.heapMB),
    domNodes: fit((sample) => sample.domNodes),
    listeners: fit((sample) => sample.listeners),
  };
}

/** The soak measures growing past their leak bars. */
export function soakLeaks(samples: ReadonlyArray<SoakSample>) {
  const slopes = soakSlopes(samples);
  return (Object.keys(SOAK_LEAK) as Array<keyof typeof SOAK_LEAK>).filter(
    (key) => slopes[key] > SOAK_LEAK[key],
  );
}

/** Event Timing reports only paints of 16 ms or more; a null paint is under it, so counts as 16. */
export const PAINT_THRESHOLD_MS = 16;
const censoredPaint = (value: number | null) => value ?? PAINT_THRESHOLD_MS;

/**
 * Every compared metric of a file, one value per run: the median of the run's switches or steps
 * for latencies and renders, so samples from one page never pass for independent runs.
 */
export function flatten(metrics: ClientMetrics): Map<string, number[]> {
  const values = new Map<string, number[]>();
  for (const run of metrics.runs) {
    const inRun = new Map<string, number[]>();
    const add = (key: string, value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      inRun.set(key, [...(inRun.get(key) ?? []), value]);
    };
    const groups = new Map<string, Switch[]>();
    for (const entry of run.switches) {
      const key = `switch.${entry.case}.${entry.visit}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
      add(`${key}.paintMs`, censoredPaint(entry.paintMs));
      add(`${key}.contentMs`, entry.contentMs);
      add(`${key}.loafMs`, entry.loafMs);
      add(`${key}.renders`, entry.renders?.renders);
      add(`${key}.commits`, entry.renders?.commits);
    }
    for (const [key, entries] of groups) {
      const missed = entries.filter((entry) => !entry.firstFrameContent).length;
      add(`${key}.firstFrameMissPct`, (missed / entries.length) * 100);
    }
    for (const entry of run.steps ?? []) {
      const key = `step.${entry.case}.${entry.step}`;
      add(`${key}.paintMs`, censoredPaint(entry.paintMs));
      add(`${key}.loafMs`, entry.loafMs);
      add(`${key}.droppedPct`, entry.droppedPct);
      add(`${key}.renders`, entry.renders?.renders);
      add(`${key}.commits`, entry.renders?.commits);
    }
    for (const entry of run.panels ?? []) add(`panel.${entry.case}.domNodes`, entry.panelNodes);
    for (const entry of run.trace ?? []) {
      add(`trace.${entry.label}.inputTaskMs`, entry.inputTaskMs);
      add(
        `trace.${entry.label}.forcedMs`,
        entry.forcedMs ?? entry.forcedStyleMs + entry.forcedLayoutMs,
      );
    }
    for (const entry of run.memory) {
      add(`memory.${entry.label}.heapMB`, entry.heapMB);
      add(`memory.${entry.label}.domNodes`, entry.domNodes);
    }
    for (const entry of run.idle) add(`idle.${entry.label}.taskPct`, entry.taskPct);
    if (run.soak && run.soak.length > 2) {
      const slopes = soakSlopes(run.soak);
      add("soak.heapMBPerIteration", slopes.heapMB);
      add("soak.domNodesPerIteration", slopes.domNodes);
      add("soak.listenersPerIteration", slopes.listeners);
    }
    for (const [key, samples] of inRun)
      values.set(key, [...(values.get(key) ?? []), median(samples)!]);
  }
  return values;
}

/** Settings that change what shared metrics measure, recorded in each file's meta. */
export const WORKLOAD_KEYS = ["cases", "switchRounds", "longTurns"] as const;
/** Settings that change timing without changing the workload: the render probe and the build. */
export const PROBE_KEYS = ["renders", "minified"] as const;

/** Settings two files disagree on, and those one of them did not record. */
export function workloadDifferences(
  before: ClientMetrics,
  after: ClientMetrics,
  keys: ReadonlyArray<string> = WORKLOAD_KEYS,
) {
  const differ: string[] = [];
  const unrecorded: string[] = [];
  for (const key of keys) {
    const a = before.meta[key];
    const b = after.meta[key];
    if (a === undefined || b === undefined) {
      if (a !== b) unrecorded.push(key);
    } else if (a !== b) {
      differ.push(`${key} ${a} vs ${b}`);
    }
  }
  return { differ, unrecorded };
}

const listOf = (entries: ReadonlyArray<{ readonly name: string; readonly count: number }>) =>
  entries.map((entry) => `${entry.name} ${entry.count}`).join(", ") || "–";
const weightsOf = (entries: ReadonlyArray<{ readonly name: string; readonly ms: number }>) =>
  entries.map((entry) => `\`${entry.name}\` ${entry.ms}`).join(", ") || "–";

/** The run's markdown: per case latency, renders, trace breakdown, memory, idle CPU and soak. */
export function summaryTable(metrics: ClientMetrics) {
  const switches = metrics.runs.flatMap((run) => run.switches);
  const steps = metrics.runs.flatMap((run) => run.steps ?? []);
  const lines = [
    "### Client metrics (ms, lower is better)",
    "",
    `\`${metrics.meta.commit}\`, ${metrics.runs.length} run(s), ${metrics.meta.platform}, Chromium ${metrics.meta.chromium}`,
  ];
  if (switches.length > 0) {
    lines.push(
      "",
      "| switch to | visit | n | paint p50 | paint p90 | content p50 | not in 1st frame | LoAF p50 | LoAF p90 |",
      "| :-- | :-- | --: | --: | --: | --: | --: | --: | --: |",
    );
    for (const name of new Set(switches.map((entry) => entry.case))) {
      for (const visit of ["first", "revisit"] as const) {
        const rows = switches.filter((entry) => entry.case === name && entry.visit === visit);
        if (rows.length === 0) continue;
        const paint = present(rows.map((entry) => entry.paintMs));
        const content = present(rows.map((entry) => entry.contentMs));
        const loaf = rows.map((entry) => entry.loafMs);
        const missed = rows.filter((entry) => !entry.firstFrameContent).length;
        lines.push(
          `| ${name} | ${visit} | ${rows.length} | ${cell(median(paint))} | ${cell(percentile(paint, 90))} | ${cell(median(content))} | ${missed}/${rows.length} | ${cell(median(loaf))} | ${cell(percentile(loaf, 90))} |`,
        );
      }
    }
  }
  const stepKeys = [...new Set(steps.map((entry) => `${entry.case}\u0000${entry.step}`))];
  if (stepKeys.length > 0) {
    lines.push(
      "",
      "| interaction | step | n | paint p50 | paint p90 | paints ≥16 ms | LoAF p50 | LoAF p90 | dropped frames p50 |",
      "| :-- | :-- | --: | --: | --: | --: | --: | --: | --: |",
    );
    for (const key of stepKeys) {
      const [name, step] = key.split("\u0000") as [string, string];
      const rows = steps.filter((entry) => entry.case === name && entry.step === step);
      const paint = present(rows.map((entry) => entry.paintMs));
      const loaf = rows.map((entry) => entry.loafMs);
      lines.push(
        `| ${name} | ${step} | ${rows.length} | ${cell(median(paint))} | ${cell(percentile(paint, 90))} | ${paint.length}/${rows.length} | ${cell(median(loaf))} | ${cell(percentile(loaf, 90))} | ${cell(median(rows.map((entry) => entry.droppedPct)))}% |`,
      );
    }
  }
  const rendered = [
    ...switches.map((entry) => ({ key: `switch to ${entry.case} (${entry.visit})`, ...entry })),
    ...steps.map((entry) => ({ key: `${entry.case}: ${entry.step}`, ...entry })),
  ].filter((entry) => entry.renders !== undefined);
  if (rendered.length > 0) {
    lines.push(
      "",
      "| renders per step | n | commits p50 | renders p50 | renders max | top components (mean per step) | top causes |",
      "| :-- | --: | --: | --: | --: | :-- | :-- |",
    );
    for (const key of new Set(rendered.map((entry) => entry.key))) {
      const rows = rendered.filter((entry) => entry.key === key).map((entry) => entry.renders!);
      const counts = rows.map((entry) => entry.renders);
      lines.push(
        `| ${key} | ${rows.length} | ${cell(median(rows.map((entry) => entry.commits)))} | ${cell(median(counts))} | ${cell(Math.max(...counts))} | ${listOf(topCounts(rows.map((entry) => entry.top)))} | ${listOf(
          topCounts(
            rows.map((entry) => entry.causes),
            3,
          ),
        )} |`,
      );
    }
    if (metrics.meta.minified === true) {
      lines.push(
        "",
        "Component names are minified in this build; rerun with `--unminified` to read them.",
      );
    }
  }
  const panels = metrics.runs.flatMap((run) => run.panels ?? []);
  if (panels.length > 0) {
    lines.push(
      "",
      "| panel | DOM nodes in the surface | DOM nodes in the page |",
      "| :-- | --: | --: |",
    );
    for (const name of new Set(panels.map((entry) => entry.case))) {
      const rows = panels.filter((entry) => entry.case === name);
      lines.push(
        `| ${name} | ${cell(median(rows.map((entry) => entry.panelNodes)))} | ${cell(median(rows.map((entry) => entry.documentNodes)))} |`,
      );
    }
  }
  const traced = metrics.runs.at(-1)?.trace ?? [];
  if (traced.length > 0) {
    lines.push(
      "",
      "| traced step (last run) | windows | input task | forced style | forced layout | sampled JS | long tasks after |",
      "| :-- | --: | --: | --: | --: | --: | :-- |",
    );
    for (const step of traced) {
      lines.push(
        `| ${step.label} | ${step.windows} | ${step.inputTaskMs} | ${step.forcedStyleMs} | ${step.forcedLayoutMs} | ${step.sampledMs} | ${step.longTasks.map((task) => `+${task.atMs}: ${task.ms}`).join(", ") || "–"} |`,
      );
    }
    lines.push("", "Where each traced step's input task spent its JS (ms per window):", "");
    for (const step of traced) {
      if (step.selfByPackage.length === 0 && step.longTasks.length === 0) continue;
      lines.push(
        `- **${step.label}**: self ${weightsOf(step.selfByPackage.slice(0, 4))}; libraries ${weightsOf(step.byPackage.slice(0, 4))}; sources ${weightsOf(step.bySource.slice(0, 5))}`,
      );
      for (const task of step.longTasks) {
        lines.push(`  - long task +${task.atMs} ms, ${task.ms} ms: ${weightsOf(task.top)}`);
      }
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
  metrics.runs.forEach((run, index) => {
    if (!run.soak || run.soak.length < 3) return;
    const slopes = soakSlopes(run.soak);
    const leaking = soakLeaks(run.soak);
    lines.push(
      "",
      `| soak, run ${index + 1}: iteration | heap MB | DOM nodes | listeners |`,
      "| --: | --: | --: | --: |",
      ...run.soak.map(
        (sample) =>
          `| ${sample.iteration} | ${sample.heapMB} | ${sample.domNodes} | ${sample.listeners} |`,
      ),
      `| growth per iteration | ${round(slopes.heapMB, 3)} | ${round(slopes.domNodes, 1)} | ${round(slopes.listeners, 2)} |`,
      "",
      leaking.length > 0
        ? `**Growing:** ${leaking.join(", ")} past ${leaking.map((key) => `${SOAK_LEAK[key]}`).join(", ")} per iteration over the soak's later half.`
        : "No growth past the leak bars over the soak's later half.",
    );
  });
  const skipped = metrics.runs.flatMap((run) => run.skipped ?? []);
  for (const entry of skipped) lines.push("", `Skipped ${entry.case}: ${entry.reason}`);
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

/** `compareSeries` over two files' per-run medians. */
export function compareClientMetrics(
  before: ClientMetrics,
  after: ClientMetrics,
  threshold = 10,
  floors?: Floors,
) {
  return compareSeries(
    flatten(before),
    flatten(after),
    [
      "### Client metrics (lower is better)",
      "",
      `before \`${before.meta.commit}\` (${before.runs.length} runs), after \`${after.meta.commit}\` (${after.runs.length} runs)${floors ? `, floors calibrated on ${floors.platform}` : ""}`,
    ],
    threshold,
    floors,
  );
}

/** `noiseOfSeries` over A/A pairs of files. */
export function noiseReport(
  pairs: ReadonlyArray<readonly [ClientMetrics, ClientMetrics]>,
  platform: string,
) {
  return noiseOfSeries(
    pairs.map(([before, after]) => [flatten(before), flatten(after)] as const),
    platform,
  );
}
