import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  compareMetrics,
  activityRenewalMissed,
  heapGrowth,
  nextActivityReport,
  parsePsCpuTime,
  parseRunSelection,
  pathRewrites,
  pathSpellings,
  ServerMetrics,
  slope,
} from "./server-metrics-report.ts";

const decodeMetrics = Schema.decodeSync(ServerMetrics);

type Quiet = {
  cpuPct: number;
  wakeupsPerSec: number | null;
  rssPeakMB: number;
  loopDelayP99Ms?: number;
  loopDelayMaxMs?: number;
  gcPauseMs?: number;
};
const loopAtRest = {
  loopDelayP50Ms: 0.1,
  loopDelayP99Ms: 1.5,
  loopDelayMaxMs: 8,
  gcCount: 12,
  gcPauseMs: 6,
};
const meta = { commit: "abc", platform: "linux-x64", noAgentScope: true };
const quietRuns = (...runs: Quiet[]) =>
  ({
    meta,
    runs: runs.map((quiet) => ({
      quiet: { ...loopAtRest, ...quiet, rssMB: 500, heapAfterGcMB: 200 },
    })),
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
    ["a doubled p99 loop delay under the 5 ms floor", { loopDelayP99Ms: 3 }, [], []],
    ["a p99 loop delay past it", { loopDelayP99Ms: 40 }, ["quiet.loopDelayP99Ms"], []],
    ["one longer stall under the 20 ms max floor", { loopDelayMaxMs: 25 }, [], []],
    ["GC pauses past the 10 ms floor", { gcPauseMs: 30 }, ["quiet.gcPauseMs"], []],
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

  it("reads a file written before loop delay and GC were recorded", () => {
    const older = decodeMetrics({
      meta,
      runs: [
        {
          quiet: { cpuPct: 0.3, wakeupsPerSec: 7, rssPeakMB: 500, rssMB: 500, heapAfterGcMB: 200 },
        },
      ],
    });
    const result = compareMetrics(older, quietRuns(base));
    expect(result.compared).toBe(5);
    expect(result.table).toContain("| quiet.loopDelayP99Ms | – | 1.5 | n/a | | |");
  });

  it("does not compare wakeups counted with and without the delay sampler", () => {
    const sampled = quietRuns({ ...base, wakeupsPerSec: 160 });
    const withSamples: ServerMetrics = {
      meta,
      runs: sampled.runs.map((run) => ({ quiet: { ...run.quiet, loopSamples: 2_900 } })),
    };
    const result = compareMetrics(quietRuns(base), withSamples);
    expect(result.regressed).toEqual([]);
    expect(result.table).toContain("| quiet.wakeupsPerSec | 7 | 160 | not comparable | | |");
    // The per-thread fit comes from the quiet windows, so it follows their method.
    const scaling = (wakeupsPerThread: number) => ({
      heapMBPerThread: 1,
      rssMBPerThread: 2,
      cpuPctPerThread: 0.1,
      wakeupsPerThread,
      points: [],
    });
    const fitted = (metrics: ServerMetrics, wakeupsPerThread: number): ServerMetrics => ({
      meta,
      runs: metrics.runs.map((run) => ({ ...run, scaling: scaling(wakeupsPerThread) })),
    });
    const fit = compareMetrics(fitted(quietRuns(base), 0.5), fitted(withSamples, 6));
    expect(fit.regressed).toEqual([]);
    expect(fit.table).toContain("| scaling.wakeupsPerThread | 0.5 | 6 | not comparable | | |");
    expect(compareMetrics(withSamples, withSamples).compared).toBe(10);
  });

  it("counts how many metrics both sides share", () => {
    const startupOnly: ServerMetrics = { meta, runs: [{ startup: { readyMs: 9_000 } }] };
    expect(compareMetrics(startupOnly, quietRuns(base)).compared).toBe(0);
    expect(compareMetrics(quietRuns(base), quietRuns(base)).compared).toBe(10);
  });
});

describe("compareMetrics on the busy shell snapshot", () => {
  const window = { cpuPct: 1, wakeupsPerSec: 10, rssPeakMB: 500, rssMB: 500, heapAfterGcMB: 200 };
  const busyRun = (shellMs: number, shellKB: number) =>
    ({
      meta,
      runs: [
        {
          busy: {
            readyMs: 8_000,
            projects: 9,
            ballastMB: 768,
            rest: window,
            shellMs: { median: shellMs, p90: shellMs },
            shellKB,
            git: window,
          },
        },
      ],
    }) satisfies ServerMetrics;
  it.each([
    ["40 ms slower, under the 50 ms floor", busyRun(230, 100), []],
    ["150 ms slower, past it", busyRun(340, 100), ["busy.shellMs.median", "busy.shellMs.p90"]],
    ["15 KB larger, under the 20 KB floor", busyRun(190, 115), []],
    ["40 KB larger, past it", busyRun(190, 140), ["busy.shellKB"]],
  ])("%s", (_name, after, regressed) => {
    expect(compareMetrics(busyRun(190, 100), after).regressed).toEqual(regressed);
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

describe("pathSpellings", () => {
  it.each([
    ["a POSIX path, one spelling", "/home/dev/repo", ["/home/dev/repo"]],
    [
      "a Windows path as written, JSON-escaped, and with forward slashes",
      "C:\\Users\\dev\\repo",
      ["C:\\Users\\dev\\repo", "C:\\\\Users\\\\dev\\\\repo", "C:/Users/dev/repo"],
    ],
    [
      "a path with a quote, escaped the way JSON stores it",
      '/mnt/dev/quote"repo',
      ['/mnt/dev/quote"repo', '/mnt/dev/quote\\"repo'],
    ],
    [
      "a path with a control character, escaped the way JSON stores it",
      "/mnt/dev/new\nline",
      ["/mnt/dev/new\nline", "/mnt/dev/new\\nline"],
    ],
  ])("%s", (_name, path, spellings) => {
    expect(pathSpellings(path)).toEqual(spellings);
  });
});

describe("pathRewrites", () => {
  const rewrite = (text: string, from: string, to: string) =>
    pathRewrites(from, to).reduce((value, [a, b]) => value.replaceAll(a, b), text);
  it.each([
    [
      "a POSIX path in JSON",
      '{"cwd":"/home/dev/repo/x"}',
      "/home/dev/repo",
      "/tmp/run/gone/root-0",
      '{"cwd":"/tmp/run/gone/root-0/x"}',
    ],
    [
      "a Windows path stored JSON-escaped",
      '{"cwd":"C:\\\\Users\\\\dev\\\\repo\\\\x"}',
      "C:\\Users\\dev\\repo",
      "D:\\run\\gone\\root-0",
      '{"cwd":"D:\\\\run\\\\gone\\\\root-0\\\\x"}',
    ],
    [
      "a Windows path written with forward slashes",
      "see C:/Users/dev/repo/x",
      "C:\\Users\\dev\\repo",
      "D:\\run\\gone\\root-0",
      "see D:/run/gone/root-0/x",
    ],
  ])("%s", (_name, text, from, to, expected) => {
    expect(rewrite(text, from, to)).toBe(expected);
  });
});

describe("nextActivityReport", () => {
  it.each([
    ["before it is due: wait out the interval", 1_000, 10_000, { waitMs: 16_000, late: false }],
    ["a slow reply: send now, still inside the lease", 1_000, 31_000, { waitMs: 0, late: false }],
    ["past the safe point: the lease would lapse", 1_000, 42_000, { waitMs: 0, late: true }],
  ])("%s", (_name, lastSentAt, now, expected) => {
    expect(nextActivityReport(lastSentAt, now)).toEqual(expected);
  });
});

describe("activityRenewalMissed", () => {
  it.each([
    ["sent on time, answered inside the lease", 25_000, 30_000, false],
    ["a delayed wake: sent past the safe point", 41_000, 42_000, true],
    ["sent on time, answered after the lease lapsed", 25_000, 46_000, true],
  ])("%s", (_name, sentAt, repliedAt, missed) => {
    expect(activityRenewalMissed(0, sentAt, repliedAt)).toBe(missed);
  });
});
