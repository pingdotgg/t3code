import { describe, expect, it } from "vite-plus/test";

import {
  compareMetrics,
  heapGrowth,
  parsePsCpuTime,
  parseRunSelection,
  slope,
  type ServerMetrics,
} from "./server-metrics-report.ts";

type Quiet = { cpuPct: number; wakeupsPerSec: number | null; rssPeakMB: number };
const meta = { commit: "abc", platform: "linux-x64", noAgentScope: true };
const quietRuns = (...runs: Quiet[]) =>
  ({
    meta,
    runs: runs.map((quiet) => ({ quiet: { ...quiet, rssMB: 500, heapAfterGcMB: 200 } })),
  }) satisfies ServerMetrics;
const base: Quiet = { cpuPct: 0.3, wakeupsPerSec: 7, rssPeakMB: 500 };
const cpuRuns = (...values: number[]) =>
  quietRuns(...values.map((cpuPct) => ({ ...base, cpuPct })));

describe("compareMetrics", () => {
  it.each([
    ["a CPU jump past both the percentage and the floor", { cpuPct: 18.6 }, ["quiet.cpuPct"], []],
    ["a large relative change under the 1 point CPU floor", { cpuPct: 0.9 }, [], []],
    ["RSS growth under the 15 MB floor", { rssPeakMB: 512 }, [], []],
    ["RSS growth past it", { rssPeakMB: 585 }, ["quiet.rssPeakMB"], []],
    [
      "an improvement past the floors",
      { cpuPct: 0.1, wakeupsPerSec: 7, rssPeakMB: 400 },
      [],
      ["quiet.rssPeakMB"],
    ],
  ])("one run each: %s", (_name, change, regressed, improved) => {
    const result = compareMetrics(quietRuns(base), quietRuns({ ...base, ...change }));
    expect(result.regressed).toEqual(regressed);
    expect(result.improved).toEqual(improved);
  });

  it("shows a metric missing on one side as n/a, not as a change", () => {
    const before = quietRuns({ ...base, wakeupsPerSec: null });
    const result = compareMetrics(before, quietRuns({ ...base, wakeupsPerSec: 50 }));
    expect(result.regressed).toEqual([]);
    expect(result.table).toContain("| quiet.wakeupsPerSec | – | 50 | n/a | | |");
  });

  it("flags repeated runs only when the whole interval clears the limit", () => {
    const steady = cpuRuns(26.1, 27.4, 25.8);
    const fixed = cpuRuns(2.2, 2.5, 2.1);
    expect(compareMetrics(steady, fixed).improved).toContain("quiet.cpuPct");
    expect(compareMetrics(fixed, steady).regressed).toContain("quiet.cpuPct");
    // The medians differ by 2.8 points, past the floor, but a resampled median can match.
    expect(compareMetrics(fixed, cpuRuns(2.2, 5, 9)).regressed).toEqual([]);
  });

  it("counts how many metrics both sides share", () => {
    const startupOnly: ServerMetrics = { meta, runs: [{ startup: { readyMs: 9_000 } }] };
    expect(compareMetrics(startupOnly, quietRuns(base)).compared).toBe(0);
    expect(compareMetrics(quietRuns(base), quietRuns(base)).compared).toBe(5);
  });
});

describe("heapGrowth", () => {
  it("lists only constructors that grew, small growth included", () => {
    const before = new Map([
      ["Shrank", { count: 10, bytes: 5_000_000 }],
      ["Flat", { count: 3, bytes: 1_000 }],
      ["Grew", { count: 1, bytes: 1_000 }],
    ]);
    const after = new Map([
      ["Shrank", { count: 5, bytes: 1_000_000 }],
      ["Flat", { count: 3, bytes: 1_000 }],
      ["Grew", { count: 2, bytes: 1_500 }],
      ["New", { count: 4, bytes: 3_000_000 }],
    ]);
    expect(heapGrowth(before, after)).toEqual([
      { constructor: "New", count: 4, MB: 3 },
      { constructor: "Grew", count: 1, MB: 0 },
    ]);
  });
});

describe("slope", () => {
  it("fits the cost per thread", () => {
    const points: Array<readonly [number, number]> = [
      [0, 175],
      [5, 180],
      [10, 185],
      [20, 195],
    ];
    expect(slope(points)).toBeCloseTo(1);
  });
});

describe("parsePsCpuTime", () => {
  it.each([
    ["0:00.00", 0],
    ["1:02.50", 62.5],
    ["1:00:00.00", 3600],
    ["2-01:00:00", 2 * 86_400 + 3600],
    ["1-02:03", Number.NaN],
    ["::", Number.NaN],
    ["", Number.NaN],
    ["1:2:3:4", Number.NaN],
  ])("%s", (text, seconds) => {
    expect(parsePsCpuTime(text)).toBe(seconds);
  });
});

describe("parseRunSelection", () => {
  const scenarios = ["rest", "quiet", "streaming"];
  it.each([
    [
      "the default thread counts",
      { only: "", threads: "0,5,10,20", soak: 0 },
      { only: [], threads: [0, 5, 10, 20] },
    ],
    [
      "descending thread counts",
      { only: "", threads: "5,20,10", soak: 0 },
      { error: "--threads takes ascending counts such as 0,5,10,20" },
    ],
    [
      "an empty thread count",
      { only: "", threads: "0,,10", soak: 0 },
      { error: "--threads takes ascending counts such as 0,5,10,20" },
    ],
    [
      "named scenarios",
      { only: "rest,quiet", threads: "0", soak: 0 },
      { only: ["rest", "quiet"], threads: [0] },
    ],
    [
      "an unknown scenario",
      { only: "rest,idle", threads: "0", soak: 0 },
      { error: "unknown scenario: idle" },
    ],
    ["a soak alone", { only: "", threads: "0", soak: 10 }, { only: ["none"], threads: [0] }],
    [
      "a soak with scenarios",
      { only: "rest", threads: "0", soak: 10 },
      { only: ["rest"], threads: [0] },
    ],
    [
      "a negative soak",
      { only: "", threads: "0", soak: -1 },
      { error: "--soak takes minutes, 0 for none" },
    ],
    [
      "an infinite soak",
      { only: "", threads: "0", soak: Number.POSITIVE_INFINITY },
      { error: "--soak takes minutes, 0 for none" },
    ],
  ])("%s", (_name, input, expected) => {
    expect(parseRunSelection({ ...input, scenarios })).toEqual(expected);
  });
});
