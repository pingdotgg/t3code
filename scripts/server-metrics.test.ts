import { describe, expect, it } from "vite-plus/test";

import { compareMetrics, slope, type ServerMetrics } from "./server-metrics.ts";

type Quiet = { cpuPct: number; wakeupsPerSec: number | null; rssPeakMB: number };
const quietRuns = (...runs: Quiet[]) =>
  ({
    meta: { commit: "abc", platform: "linux-x64", noAgentScope: true },
    runs: runs.map((quiet) => ({ quiet: { ...quiet, rssMB: 500, heapAfterGcMB: 200 } })),
  }) satisfies ServerMetrics;
const base: Quiet = { cpuPct: 0.3, wakeupsPerSec: 7, rssPeakMB: 500 };

describe("compareMetrics", () => {
  it.each([
    ["a CPU jump past both the percentage and the floor", { cpuPct: 18.6 }, ["quiet.cpuPct"]],
    ["a large relative change under the 1 point CPU floor", { cpuPct: 0.9 }, []],
    ["RSS growth under the 15 MB floor", { rssPeakMB: 512 }, []],
    ["RSS growth past it", { rssPeakMB: 585 }, ["quiet.rssPeakMB"]],
    ["an improvement", { cpuPct: 0.1, wakeupsPerSec: 7 }, []],
  ])("one run each: %s", (_name, change, regressed) => {
    expect(compareMetrics(quietRuns(base), quietRuns({ ...base, ...change })).regressed).toEqual(
      regressed,
    );
  });

  it("does not treat a metric missing on one side as a regression", () => {
    const before = quietRuns({ ...base, wakeupsPerSec: null });
    expect(compareMetrics(before, quietRuns({ ...base, wakeupsPerSec: 9 })).regressed).toEqual([]);
  });

  it("flags repeated runs only when the whole interval clears the limit", () => {
    const steady = quietRuns(
      { ...base, cpuPct: 26.1 },
      { ...base, cpuPct: 27.4 },
      { ...base, cpuPct: 25.8 },
    );
    const fixed = quietRuns(
      { ...base, cpuPct: 2.2 },
      { ...base, cpuPct: 2.5 },
      { ...base, cpuPct: 2.1 },
    );
    expect(compareMetrics(steady, fixed).improved).toContain("quiet.cpuPct");
    expect(compareMetrics(fixed, steady).regressed).toContain("quiet.cpuPct");
    // One noisy run on each side overlaps the other side's values.
    const noisy = quietRuns(
      { ...base, cpuPct: 2.2 },
      { ...base, cpuPct: 9 },
      { ...base, cpuPct: 2.4 },
    );
    expect(compareMetrics(fixed, noisy).regressed).toEqual([]);
  });

  it("reads a single-run file from before runs existed", () => {
    const legacy = { meta: { commit: "old" }, quiet: { ...base, rssMB: 500, heapAfterGcMB: 200 } };
    const after = quietRuns({ ...base, cpuPct: 18.6 });
    expect(compareMetrics(legacy as unknown as ServerMetrics, after).regressed).toEqual([
      "quiet.cpuPct",
    ]);
  });
});

describe("slope", () => {
  it("fits the cost per thread", () => {
    expect(
      slope([
        [0, 175],
        [5, 180],
        [10, 185],
        [20, 195],
      ]),
    ).toBeCloseTo(1);
  });
});
