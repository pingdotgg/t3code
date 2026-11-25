import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  analyzeClickTasks,
  CASES,
  ClientMetrics,
  compareClientMetrics,
  flatten,
  parseCases,
  percentile,
  summaryTable,
  type Switch,
  type TraceEvent,
} from "./client-metrics-report.ts";

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

describe("parseCases", () => {
  it("defaults to every case and keeps benchmark order", () => {
    expect(parseCases("")).toEqual({ cases: CASES });
    expect(parseCases("device, short")).toEqual({ cases: ["short", "device"] });
  });

  it("names unknown cases", () => {
    expect(parseCases("short,diffs")).toEqual({
      error: `unknown cases: diffs; choose from ${CASES.join(", ")}`,
    });
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

  it("summarizes every case, memory and idle CPU", () => {
    const table = summaryTable(file("abc", [[100, 200]]));
    expect(table).toContain("| diff | revisit | 2 | 150 | 200 |");
    expect(table).toContain("| loaded | 60 | 2000 | 1000 |");
    expect(table).toContain("| on the working thread | 10 | 5 | 1 | 0 |");
  });
});

describe("analyzeClickTasks", () => {
  const main = { pid: 1, tid: 2 };
  const events: ReadonlyArray<TraceEvent> = [
    { ...main, ph: "M", name: "thread_name", args: { name: "CrRendererMain" } },
    { ...main, ph: "X", name: "RunTask", ts: 1_000, dur: 50_000 },
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
      args: {
        beginData: {
          stackTrace: [{ url: "http://x/assets/app.js", lineNumber: 1, columnNumber: 10 }],
        },
      },
    },
    {
      ...main,
      ph: "X",
      name: "Layout",
      ts: 7_000,
      dur: 6_000,
      args: {
        beginData: {
          stackTrace: [{ url: "http://x/assets/app.js", lineNumber: 1, columnNumber: 10 }],
        },
      },
    },
    // The frame's own layout carries no stack, so it is not forced.
    { ...main, ph: "X", name: "Layout", ts: 30_000, dur: 9_000 },
    // Outside the click's task.
    {
      ...main,
      ph: "X",
      name: "Layout",
      ts: 90_000,
      dur: 9_000,
      args: {
        beginData: {
          stackTrace: [{ url: "http://x/assets/app.js", lineNumber: 1, columnNumber: 10 }],
        },
      },
    },
  ];

  it("sums forced style and layout inside each click's task, by mapped call site", () => {
    const result = analyzeClickTasks(events, ["diff"], (_url, line, column) =>
      line === 0 && column === 9 ? "apps/web/src/Panel.tsx:12" : undefined,
    );
    expect(result?.perClick).toEqual([
      { case: "diff", clickTaskMs: 50, forcedStyleMs: 4, forcedLayoutMs: 6 },
    ]);
    expect(result?.callSites).toEqual([{ site: "apps/web/src/Panel.tsx:12", ms: 10, count: 2 }]);
  });

  it("refuses to label clicks it cannot match", () => {
    expect(analyzeClickTasks(events, ["hub", "diff"], () => undefined)).toBeUndefined();
  });
});
