import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { rendersOf } from "./client-metrics-probes.ts";
import {
  CASES,
  ClientMetrics,
  compareClientMetrics,
  flatten,
  INTERACTION_CASES,
  noiseReport,
  parseCases,
  percentile,
  slope,
  soakSlopes,
  summaryTable,
  type Step,
  type Switch,
} from "./client-metrics-report.ts";
import {
  analyzeTrace,
  END_LABEL,
  MARK_PREFIX,
  normalizeSource,
  packageOf,
  type TraceEvent,
} from "./client-metrics-trace.ts";

const decode = Schema.decodeSync(ClientMetrics);

const switchTo = (name: string, paintMs: number, overrides: Partial<Switch> = {}): Switch => ({
  case: name,
  visit: "revisit",
  round: 1,
  paintMs,
  contentMs: paintMs,
  firstFrameContent: true,
  loafMs: paintMs,
  ...overrides,
});

const renders = (count: number) => ({
  commits: 3,
  renders: count,
  top: [{ name: "TimelineRow", count }],
  causes: [{ name: "TimelineRow mount", count }],
});

const step = (overrides: Partial<Step> = {}): Step => ({
  case: "type-long",
  step: "key",
  round: 0,
  paintMs: 24,
  loafMs: 0,
  droppedPct: 0,
  ...overrides,
});

const file = (commit: string, paints: ReadonlyArray<ReadonlyArray<number>>) =>
  decode({
    meta: { commit, platform: "linux-x64", chromium: "1", cpus: 8 },
    runs: paints.map((run) => ({
      switches: run.map((paint) => switchTo("diff", paint)),
      memory: [{ label: "loaded", heapMB: 60, domNodes: 2_000, listeners: 1_000 }],
      idle: [
        {
          label: "on the working thread",
          seconds: 10,
          taskPct: 10,
          scriptPct: 5,
          stylePct: 1,
          layoutPct: 0,
        },
      ],
    })),
  });

const withRenders = (commit: string, counts: ReadonlyArray<ReadonlyArray<number>>) =>
  decode({
    meta: { commit, platform: "linux-x64" },
    runs: counts.map((run) => ({
      switches: [],
      steps: run.map((count) => step({ renders: renders(count) })),
      memory: [],
      idle: [],
    })),
  });

describe("parseCases", () => {
  it("defaults to every case and keeps benchmark order", () => {
    expect(parseCases("")).toEqual({ cases: CASES });
    expect(parseCases("settings, device, short")).toEqual({
      cases: ["short", "device", "settings"],
    });
  });

  it("expands the groups", () => {
    expect(parseCases("interactions")).toEqual({ cases: INTERACTION_CASES });
    expect(parseCases("switches,palette")).toEqual({
      cases: CASES.filter(
        (name) => !INTERACTION_CASES.includes(name as never) || name === "palette",
      ),
    });
  });

  it("names unknown cases", () => {
    const parsed = parseCases("short,diffs");
    expect("error" in parsed && parsed.error).toMatch(/^unknown cases: diffs; choose from/);
  });
});

describe("report math", () => {
  it("takes the nearest-rank p90, a value that was measured", () => {
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBe(90);
    expect(percentile([5, 1, 3], 90)).toBe(5);
    expect(percentile([], 90)).toBeNull();
  });

  it("keeps a first-frame miss share per run, and drops paints under 16 ms", () => {
    const metrics = decode({
      meta: { commit: "a" },
      runs: [
        {
          switches: [
            switchTo("short", 100, { firstFrameContent: false }),
            switchTo("short", 120),
            switchTo("short", 0, { paintMs: null }),
          ],
          memory: [],
          idle: [],
        },
      ],
    });
    const flat = flatten(metrics);
    expect(flat.get("switch.short.revisit.paintMs")).toEqual([100, 120]);
    expect(flat.get("switch.short.revisit.firstFrameMissPct")).toEqual([(1 / 3) * 100]);
  });

  it("flattens steps, renders, panels and traces", () => {
    const flat = flatten(
      decode({
        meta: { commit: "a" },
        runs: [
          {
            switches: [switchTo("long", 100, { renders: renders(400) })],
            steps: [step({ paintMs: null, droppedPct: 12, renders: renders(9) })],
            panels: [{ case: "diff", panelNodes: 5_000, documentNodes: 9_000 }],
            trace: [
              {
                label: "switch:long",
                windows: 1,
                inputTaskMs: 80,
                forcedStyleMs: 3,
                forcedLayoutMs: 4,
                sampledMs: 70,
                selfByPackage: [],
                bySource: [],
                byPackage: [],
                longTasks: [],
              },
            ],
            memory: [],
            idle: [],
          },
        ],
      }),
    );
    expect(flat.get("switch.long.revisit.renders")).toEqual([400]);
    expect(flat.get("step.type-long.key.paintMs")).toBeUndefined();
    expect(flat.get("step.type-long.key.droppedPct")).toEqual([12]);
    expect(flat.get("step.type-long.key.renders")).toEqual([9]);
    expect(flat.get("step.type-long.key.commits")).toEqual([3]);
    expect(flat.get("panel.diff.domNodes")).toEqual([5_000]);
    expect(flat.get("trace.switch:long.forcedMs")).toEqual([7]);
  });

  it("calls a change worse only past the threshold and the floor", () => {
    const before = file("a", [
      [100, 102, 98],
      [101, 99, 100],
    ]);
    const worse = compareClientMetrics(
      before,
      file("b", [
        [150, 152, 149],
        [151, 148, 150],
      ]),
    );
    expect(worse.regressed).toEqual([
      "switch.diff.revisit.contentMs",
      "switch.diff.revisit.loafMs",
      "switch.diff.revisit.paintMs",
    ]);
    const same = compareClientMetrics(
      before,
      file("b", [
        [104, 101, 103],
        [100, 102, 105],
      ]),
    );
    expect(same.regressed).toEqual([]);
    expect(same.improved).toEqual([]);
  });

  it("gates on render counts, which barely move between runs", () => {
    const before = withRenders("a", [
      [40, 40, 41],
      [40, 40, 40],
    ]);
    const result = compareClientMetrics(
      before,
      withRenders("b", [
        [52, 52, 52],
        [52, 53, 52],
      ]),
    );
    expect(result.regressed).toEqual(["step.type-long.key.renders"]);
  });

  it("uses calibrated floors, and never counts a metric too noisy to gate on", () => {
    const before = file("a", [
      [100, 102, 98],
      [101, 99, 100],
    ]);
    const after = file("b", [
      [150, 152, 149],
      [151, 148, 150],
    ]);
    const result = compareClientMetrics(before, after, 10, {
      platform: "linux-x64",
      floors: {
        "switch.diff.revisit.paintMs": { floor: 80, gate: true },
        "switch.diff.revisit.loafMs": { floor: 1, gate: false },
      },
    });
    expect(result.regressed).toEqual(["switch.diff.revisit.contentMs"]);
    expect(result.noisy).toEqual(["switch.diff.revisit.loafMs"]);
  });

  it("summarizes every case, renders, memory and idle CPU", () => {
    const table = summaryTable(file("abc", [[100, 200]]));
    expect(table).toContain("| diff | revisit | 2 | 150 | 200 |");
    expect(table).toContain("| loaded | 60 | 2000 | 1000 |");
    expect(table).toContain("| on the working thread | 10 | 5 | 1 | 0 |");
    const rendered = summaryTable({
      ...withRenders("abc", [[10, 30]]),
      meta: { commit: "abc", minified: true },
    });
    expect(rendered).toContain("| type-long: key | 2 | 3 | 20 | 30 | TimelineRow 20 |");
    expect(rendered).toContain("Component names are minified");
  });
});

describe("soak", () => {
  it("fits growth per iteration past the warm-up sample", () => {
    expect(
      slope([
        [0, 1],
        [1, 3],
        [2, 5],
      ]),
    ).toBe(2);
    expect(slope([[1, 4]])).toBe(0);
    const slopes = soakSlopes([
      { iteration: 0, heapMB: 50, domNodes: 1_000, listeners: 100 },
      { iteration: 2, heapMB: 80, domNodes: 3_000, listeners: 140 },
      { iteration: 4, heapMB: 80, domNodes: 3_040, listeners: 140 },
      { iteration: 6, heapMB: 80, domNodes: 3_080, listeners: 140 },
    ]);
    expect(slopes).toEqual({ heapMB: 0, domNodes: 20, listeners: 0 });
  });
});

describe("noiseReport", () => {
  it("derives a floor from the A/A spread and flags metrics too noisy to gate", () => {
    const steady = withRenders("a", [
      [40, 40, 40],
      [40, 41, 40],
    ]);
    const { floors, rows } = noiseReport([[steady, steady]], "linux-x64");
    expect(floors.platform).toBe("linux-x64");
    expect(floors.floors["step.type-long.key.renders"]).toEqual({ floor: 0.25, gate: true });
    const noisy = (paints: ReadonlyArray<number>) =>
      decode({
        meta: { commit: "a", platform: "linux-x64" },
        runs: [{ switches: paints.map((paint) => switchTo("long", paint)), memory: [], idle: [] }],
      });
    const loose = noiseReport([[noisy([20, 200, 30, 180]), noisy([190, 25, 210, 22])]], "x");
    const row = loose.rows.find((entry) => entry.metric === "switch.long.revisit.paintMs");
    expect(row?.gate).toBe(false);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("probe readings", () => {
  it("keeps the top entries of a render reading", () => {
    const top = Array.from({ length: 30 }, (_, index) => ({
      name: `C${index}`,
      count: 30 - index,
    }));
    const kept = rendersOf({ commits: 2, renders: 465, top, causes: top, slots: ["C0 #1=x"] }, 3);
    expect(kept).toEqual({
      commits: 2,
      renders: 465,
      top: top.slice(0, 3),
      causes: top.slice(0, 3),
    });
  });
});

describe("source names", () => {
  it("shortens library paths and names their package", () => {
    const source = normalizeSource(
      "node_modules/.pnpm/@base-ui+react@1.0.0/node_modules/@base-ui/react/esm/tooltip.js",
    );
    expect(source).toBe("nm:@base-ui/react/esm/tooltip.js");
    expect(packageOf(source)).toBe("nm:@base-ui/react");
    expect(packageOf("nm:react-dom/cjs/react-dom.js")).toBe("nm:react-dom");
    expect(packageOf("apps/web/src/components/ChatView.tsx")).toBe("apps/web");
    expect(packageOf("(garbage collector)")).toBe("(garbage collector)");
  });
});

describe("analyzeTrace", () => {
  const main = { pid: 1, tid: 2 };
  const stack = [{ url: "http://x/assets/app.js", lineNumber: 1, columnNumber: 10 }];
  const frame = (url: string, line: number) => ({
    functionName: "f",
    url,
    lineNumber: line,
    columnNumber: 0,
  });
  const events: ReadonlyArray<TraceEvent> = [
    { ...main, ph: "M", name: "thread_name", args: { name: "CrRendererMain" } },
    { ...main, ph: "R", name: `${MARK_PREFIX}switch:diff`, ts: 500 },
    { ...main, ph: "X", name: "RunTask", ts: 1_000, dur: 20_500 },
    {
      ...main,
      ph: "X",
      name: "EventDispatch",
      ts: 1_100,
      dur: 40_000,
      args: { data: { type: "click" } },
    },
    {
      ...main,
      ph: "X",
      name: "UpdateLayoutTree",
      ts: 2_000,
      dur: 4_000,
      args: { beginData: { stackTrace: stack } },
    },
    {
      ...main,
      ph: "X",
      name: "Layout",
      ts: 7_000,
      dur: 6_000,
      args: { beginData: { stackTrace: stack } },
    },
    // The frame's own layout carries no stack, so it is not forced.
    { ...main, ph: "X", name: "Layout", ts: 30_000, dur: 9_000 },
    // A long task after the click's, and one after the step settled.
    { ...main, ph: "X", name: "RunTask", ts: 200_000, dur: 60_000 },
    { ...main, ph: "R", name: `${MARK_PREFIX}${END_LABEL}`, ts: 300_000 },
    { ...main, ph: "X", name: "RunTask", ts: 400_000, dur: 90_000 },
    // A step whose input task carries nothing to sample.
    { ...main, ph: "R", name: `${MARK_PREFIX}palette:key`, ts: 2_000_000 },
    { ...main, ph: "X", name: "RunTask", ts: 2_000_100, dur: 5_000 },
    {
      ...main,
      ph: "X",
      name: "EventDispatch",
      ts: 2_000_200,
      dur: 1_000,
      args: { data: { type: "keydown" } },
    },
    { ...main, ph: "P", name: "Profile", id: "0x1", args: { data: { startTime: 0 } } },
    {
      ...main,
      ph: "P",
      name: "ProfileChunk",
      id: "0x1",
      args: {
        data: {
          cpuProfile: {
            nodes: [
              { id: 1, callFrame: { functionName: "(root)" } },
              { id: 2, parent: 1, callFrame: frame("http://x/assets/react.js", 0) },
              { id: 3, parent: 2, callFrame: frame("http://x/assets/app.js", 0) },
              // The same file twice on one stack still counts once per sample.
              { id: 4, parent: 3, callFrame: frame("http://x/assets/app.js", 5) },
              { id: 5, parent: 4, callFrame: frame("http://x/assets/lib.js", 0) },
            ],
            // 1 ms apart: 10 ms in the app, 10 in the library under it, an idle sample, then
            // 10 ms in the long task.
            samples: [...Array(10).fill(4), ...Array(10).fill(5), 1, ...Array(10).fill(3), 1],
          },
          timeDeltas: [2_000, ...Array(20).fill(1_000), 178_000, ...Array(10).fill(1_000)],
        },
      },
    },
  ];
  const mapper = (url: string, line: number) => {
    if (url.endsWith("react.js")) return { source: "node_modules/react-dom/index.js", line: 0 };
    if (url.endsWith("lib.js")) {
      return { source: "node_modules/.pnpm/x@1/node_modules/@base-ui/react/a.js", line: 0 };
    }
    if (url.endsWith("app.js")) return { source: "apps/web/src/Panel.tsx", line: line + 11 };
    return undefined;
  };

  it("splits each marked step's input task into forced work and JS by source", () => {
    const result = analyzeTrace(events, mapper)!;
    expect(result.profiled).toBe(true);
    expect(result.callSites).toEqual([{ site: "apps/web/src/Panel.tsx:12", ms: 10, count: 2 }]);
    const diff = result.steps.find((entry) => entry.label === "switch:diff")!;
    expect(diff).toMatchObject({
      windows: 1,
      inputTaskMs: 20.5,
      forcedStyleMs: 4,
      forcedLayoutMs: 6,
      sampledMs: 20,
    });
    expect(diff.selfByPackage).toEqual([
      { name: "apps/web", ms: 10 },
      { name: "nm:@base-ui/react", ms: 10 },
    ]);
    expect(diff.bySource).toEqual([
      { name: "apps/web/src/Panel.tsx", ms: 20 },
      { name: "nm:@base-ui/react/a.js", ms: 10 },
    ]);
    expect(diff.byPackage).toEqual([
      { name: "apps/web", ms: 20 },
      { name: "nm:@base-ui/react", ms: 10 },
    ]);
    expect(diff.longTasks).toEqual([
      { atMs: 200, ms: 60, top: [{ name: "apps/web/src/Panel.tsx", ms: 10 }] },
    ]);
    const key = result.steps.find((entry) => entry.label === "palette:key")!;
    expect(key).toMatchObject({ inputTaskMs: 5, sampledMs: 0, longTasks: [] });
    expect(result.steps.map((entry) => entry.label)).toEqual(["switch:diff", "palette:key"]);
  });

  it("needs a renderer main thread", () => {
    expect(analyzeTrace(events.slice(1), mapper)).toBeUndefined();
  });
});
