import { describe, expect, it } from "vite-plus/test";

import { compareMetrics, type ServerMetrics } from "./server-metrics.ts";

const metrics = (quiet: { cpuPct: number; wakeupsPerSec: number | null; rssPeakMB: number }) =>
  ({
    meta: { commit: "abc", platform: "linux-x64", macPath: true },
    quiet: { ...quiet, heapAfterGcMB: 200 },
  }) satisfies ServerMetrics;

describe("compareMetrics", () => {
  it.each([
    ["a CPU jump past both the percentage and the floor", { cpuPct: 18.6 }, ["quiet.cpuPct"]],
    ["a large relative change under the 1 point CPU floor", { cpuPct: 0.9 }, []],
    ["RSS growth under the 15 MB floor", { rssPeakMB: 512 }, []],
    ["RSS growth past it", { rssPeakMB: 585 }, ["quiet.rssPeakMB"]],
    ["an improvement", { cpuPct: 0.1, wakeupsPerSec: 7 }, []],
  ])("%s", (_name, change, regressed) => {
    const before = metrics({ cpuPct: 0.3, wakeupsPerSec: 7, rssPeakMB: 500 });
    const after = metrics({ cpuPct: 0.3, wakeupsPerSec: 7, rssPeakMB: 500, ...change });
    expect(compareMetrics(before, after).regressed).toEqual(regressed);
  });

  it("does not treat a metric missing on one side as a regression", () => {
    const before = metrics({ cpuPct: 0.3, wakeupsPerSec: null, rssPeakMB: 500 });
    const after = metrics({ cpuPct: 0.3, wakeupsPerSec: 9, rssPeakMB: 500 });
    expect(compareMetrics(before, after).regressed).toEqual([]);
  });
});
