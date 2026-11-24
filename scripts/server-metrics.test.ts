import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  compareMetrics,
  competingBetween,
  activityRenewalMissed,
  describeFailure,
  heapGrowth,
  heapRetainers,
  loadWarnings,
  nextActivityReport,
  noiseReport,
  noisePairProblem,
  parsePsCpuTime,
  profileMismatch,
  parseRunSelection,
  retainerGrowth,
  pathRewrites,
  pathSpellings,
  ServerMetrics,
  slope,
} from "./server-metrics-report.ts";
import { runAbRounds } from "./server-metrics.ts";

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

// Fixed floors, so these cases test how compare gates rather than the calibrated table.
const gatedRules = [
  { pattern: /cpuPct$/, floor: 1, gate: true },
  { pattern: /wakeupsPerSec$/, floor: 20, gate: true },
  { pattern: /MB$/, floor: 15, gate: true },
  { pattern: /loopDelayP99Ms$/, floor: 5, gate: true },
  { pattern: /loopDelayMaxMs$/, floor: 20, gate: true },
  { pattern: /gcPauseMs$/, floor: 10, gate: true },
  { pattern: /./, floor: 300, gate: true },
];

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
    const result = compareMetrics(
      quietRuns(base),
      quietRuns({ ...base, ...change }),
      10,
      gatedRules,
    );
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
    expect(compareMetrics(steady, fixed, 10, gatedRules).improved).toContain("quiet.cpuPct");
    expect(compareMetrics(fixed, steady, 10, gatedRules).regressed).toContain("quiet.cpuPct");
    // The medians differ by 2.8 points, past the floor, but a resampled median can match.
    expect(compareMetrics(fixed, cpuRuns(2.2, 5, 9), 10, gatedRules).regressed).toEqual([]);
  });

  it("compares the unequal run counts an ab that stopped early leaves", () => {
    const steady = cpuRuns(26.1, 27.4, 25.8);
    const partial = compareMetrics(steady, cpuRuns(2.2, 2.5), 10, gatedRules);
    expect(partial.improved).toContain("quiet.cpuPct");
    expect(partial.table).toContain("(3 runs), after `abc` (2 runs)");
    const single = compareMetrics(steady, cpuRuns(2.2), 10, gatedRules);
    expect(single.improved).toContain("quiet.cpuPct");
    expect(single.table).toContain("| quiet.cpuPct | 26.1 | 2.2 | -92% |  | better |");
    expect(compareMetrics(steady, cpuRuns(), 10, gatedRules).compared).toBe(0);
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

describe("compareMetrics with noise rules", () => {
  const rules = [
    { pattern: /cpuPct$/, floor: 1, gate: true },
    { pattern: /loopDelayMaxMs$/, floor: 20, gate: false },
    { pattern: /./, floor: 1_000, gate: true },
  ];
  it.each([
    ["a gated metric past its floor", { cpuPct: 5 }, ["quiet.cpuPct"], []],
    ["an ungated metric far past its floor", { loopDelayMaxMs: 300 }, [], ["quiet.loopDelayMaxMs"]],
    ["an ungated metric under its floor", { loopDelayMaxMs: 20 }, [], []],
  ])("%s", (_name, change, regressed, informational) => {
    const result = compareMetrics(quietRuns(base), quietRuns({ ...base, ...change }), 10, rules);
    expect(result.regressed).toEqual(regressed);
    expect(result.informational).toEqual(informational);
  });

  it("marks an ungated metric in the table either way", () => {
    const result = compareMetrics(quietRuns(base), quietRuns(base), 10, rules);
    expect(result.table).toContain("| quiet.loopDelayMaxMs | 8 | 8 | 0% |  | noisy |");
  });
});

describe("compareMetrics on each platform's noise floors", () => {
  // The default floor for working.rssMBPerThread is 0.2 MB; Windows A/A runs needed 0.6.
  const onPlatform = (platform: string, rssMBPerThread: number) => {
    const working = {
      active: {},
      heapMBPerThread: 0.2,
      rssMBPerThread,
      cpuPctPerThread: 0,
      loopDelayP99MsPerThread: 0,
    };
    return {
      meta: { ...meta, platform },
      runs: [{ working }, { working }],
    } satisfies ServerMetrics;
  };
  const regressed = (before: ServerMetrics, after: ServerMetrics) =>
    compareMetrics(before, after, 10).regressed;

  it("gates Linux files on the default floor", () => {
    expect(regressed(onPlatform("linux-x64", 1), onPlatform("linux-x64", 1.4))).toEqual([
      "working.rssMBPerThread",
    ]);
  });

  it("gates Windows files on the Windows floor", () => {
    expect(regressed(onPlatform("win32-x64", 1), onPlatform("win32-x64", 1.4))).toEqual([]);
    expect(regressed(onPlatform("win32-x64", 1), onPlatform("win32-x64", 1.8))).toEqual([
      "working.rssMBPerThread",
    ]);
  });

  it("falls back to the default floor with a warning when the platforms differ", () => {
    const result = compareMetrics(onPlatform("linux-x64", 1), onPlatform("win32-x64", 1.4));
    expect(result.regressed).toEqual(["working.rssMBPerThread"]);
    expect(result.warnings).toEqual([
      "the files come from linux-x64 and win32-x64, so the default noise floors apply",
    ]);
  });

  it("marks the noise report against the platform's floor", () => {
    const pair = (platform: string) => [onPlatform(platform, 1), onPlatform(platform, 1)] as const;
    const floor = (platform: string) =>
      noiseReport([pair(platform)]).rows.find(({ metric }) => metric === "working.rssMBPerThread")
        ?.floor;
    expect(floor("linux-x64")).toBe(0.2);
    expect(floor("win32-x64")).toBe(0.6);
  });
});

describe("noisePairProblem", () => {
  const at = (commit: string | null): ServerMetrics => ({ meta: { ...meta, commit }, runs: [] });
  it.each([
    ["one commit against itself", at("abc"), at("abc"), undefined],
    [
      "an A/B directory",
      at("abc"),
      at("def"),
      "ab-out: a.json is abc and b.json def; noise floors need one commit against itself",
    ],
    [
      "a file with no commit",
      at(null),
      at(null),
      "ab-out: a.json or b.json records no commit, so it cannot be shown to be an A/A run",
    ],
  ])("%s", (_name, a, b, problem) => {
    expect(noisePairProblem("ab-out", a, b)).toBe(problem);
  });
});

describe("competingBetween", () => {
  it.each([
    ["a process that kept running", [["10:500", 900]], [["10:500", 960]], 60],
    ["a new process, counted whole", [], [["11:700", 30]], 30],
    ["a reused pid is a new process", [["10:500", 900]], [["10:800", 300]], 300],
    ["a process that exited is lost", [["10:500", 900]], [], 0],
  ] as const)("%s", (_name, before, after, seconds) => {
    expect(competingBetween(new Map(before), new Map(after))).toBe(seconds);
  });
});

describe("loadWarnings", () => {
  const loaded = (cpus: number | null, ...machines: Array<[number | null, number | null]>) =>
    ({
      meta: { ...meta, cpus },
      runs: machines.map(([load1, otherCpuCores]) => ({
        machine: { load1, otherCpuCores, minutes: 10 },
      })),
    }) satisfies ServerMetrics;
  it.each([
    ["a quiet machine", loaded(16, [4, 1], [5, 2]), 0],
    ["load past 0.75 per CPU with other processes unknown", loaded(16, [4, null], [12.5, null]), 1],
    ["high load from the run's own agents", loaded(16, [21, 1]), 0],
    ["other processes on a quarter of the cores", loaded(16, [4, 4.1]), 1],
    ["no CPU count", loaded(null, [40, 40]), 0],
    ["no machine state, as in older files", { meta: { ...meta, cpus: 16 }, runs: [{}] }, 0],
  ])("%s", (_name, metrics, count) => {
    expect(loadWarnings("before", metrics)).toHaveLength(count);
  });

  it("names the worst run", () => {
    expect(loadWarnings("after", loaded(16, [13, 4.5], [14.2, 5]))[0]).toContain(
      "after ran under heavy load in 2 of 2 runs (load up to 14.2 on 16 CPUs, other node/T3/agent processes up to 5 cores)",
    );
  });

  it("is reported by compareMetrics", () => {
    expect(compareMetrics(quietRuns(base), loaded(16, [20, null])).warnings).toHaveLength(1);
  });
});

describe("noiseReport", () => {
  it.each([
    // Resampled medians differ by -0.3 to 1.1: half-width 0.7, so the floor is 0.35.
    ["the A/A interval", cpuRuns(2, 2.2, 2.4), cpuRuns(2.1, 3.1, 2.3), 0.7, 0.1, 0.35],
    // Constant sides: no interval, and medians 2 and 3.25 differ by 1.25.
    ["the A/A median difference", cpuRuns(2, 2), cpuRuns(3.25, 3.25), 0, 1.25, 1.3],
  ])("estimates a floor from %s, rounded up", (_name, a, b, halfWidth, aaDifference, floor) => {
    const [row] = noiseReport([[a, b]]).rows.filter(({ metric }) => metric === "quiet.cpuPct");
    expect(row).toMatchObject({ halfWidth, aaDifference, suggestedFloor: floor });
  });

  it("leaves out wakeups counted with the delay sampler on one side only", () => {
    const sampled: ServerMetrics = {
      meta,
      runs: quietRuns({ ...base, wakeupsPerSec: 160 }).runs.map((run) => ({
        quiet: { ...run.quiet, loopSamples: 2_900 },
      })),
    };
    const metrics = noiseReport([[quietRuns(base), sampled]]).rows.map(({ metric }) => metric);
    expect(metrics).not.toContain("quiet.wakeupsPerSec");
    expect(metrics).toContain("quiet.cpuPct");
  });

  it("takes the widest pair, and calls a metric noisy when its interval passes half its median", () => {
    const quiet = [cpuRuns(2, 2.1), cpuRuns(2, 2.1)] as const;
    const wild = [cpuRuns(1, 4), cpuRuns(2, 2)] as const;
    const [row] = noiseReport([quiet, wild]).rows.filter(({ metric }) => metric === "quiet.cpuPct");
    expect(row?.halfWidth).toBe(1.5);
    expect(row?.suggestedGate).toBe(false);
  });

  it("leaves out fields that describe a run", () => {
    const withMachine = (metrics: ServerMetrics): ServerMetrics => ({
      ...metrics,
      runs: metrics.runs.map((run) => ({
        ...run,
        machine: { load1: 3, otherCpuCores: 1, minutes: 9 },
      })),
    });
    const rows = noiseReport([[withMachine(cpuRuns(1)), withMachine(cpuRuns(1))]]).rows;
    expect(rows.some(({ metric }) => metric.startsWith("machine."))).toBe(false);
  });
});

describe("compareMetrics on working throughput", () => {
  const working = (turnsPerMin: number) =>
    ({
      meta,
      runs: [
        {
          working: {
            active: {
              "20": {
                ...loopAtRest,
                cpuPct: 90,
                wakeupsPerSec: 1_600,
                rssPeakMB: 700,
                rssMB: 560,
                heapAfterGcMB: 218,
                turnsPerMin,
                toRequestMs: { median: 4_000, p90: 9_000 },
                turnEndMs: { median: 16_000, p90: 25_000 },
                turnMs: { median: 24_000, p90: 36_000 },
              },
            },
            heapMBPerThread: 0.2,
            rssMBPerThread: 0.8,
            cpuPctPerThread: 0,
            loopDelayP99MsPerThread: 0,
          },
        },
      ],
    }) satisfies ServerMetrics;
  const rules = [{ pattern: /turnsPerMin$/, floor: 2, gate: true }];
  it.each([
    ["fewer turns a minute", 20, ["working.active.20.turnsPerMin"], []],
    ["more turns a minute", 45, [], ["working.active.20.turnsPerMin"]],
    ["a move under the floor", 34, [], []],
  ])("%s", (_name, turnsPerMin, regressed, improved) => {
    const result = compareMetrics(working(33), working(turnsPerMin), 5, rules);
    expect(result.regressed).toEqual(regressed);
    expect(result.improved).toEqual(improved);
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

describe("describeFailure", () => {
  it.each([
    ["a plain error", new Error("boom"), "boom"],
    [
      "an RPC error wrapping the server's",
      new Error("RpcClientError", { cause: new Error("Command x was already handled") }),
      "RpcClientError: Command x was already handled",
    ],
    ["a tagged error with no message", { _tag: "TimeoutError" }, "TimeoutError"],
    [
      "a cause that repeats its wrapper",
      new Error("lost: gone", { cause: new Error("gone") }),
      "lost: gone",
    ],
    ["a string", "exit 1", "exit 1"],
  ])("%s", (_name, error, expected) => {
    expect(describeFailure(error)).toBe(expected);
  });
});

describe("profileMismatch", () => {
  const withProfile = (profile?: string): ServerMetrics => ({
    meta: profile === undefined ? meta : { ...meta, profile },
    runs: [],
  });
  it.each([
    ["two full runs", withProfile("full"), withProfile("full"), false],
    ["a file from before profiles, against a full run", withProfile(), withProfile("full"), false],
    ["two quick runs", withProfile("quick"), withProfile("quick"), false],
    ["a full run against a quick one", withProfile(), withProfile("quick"), true],
  ])("%s", (_name, before, after, refused) => {
    expect(profileMismatch(before, after) !== undefined).toBe(refused);
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

describe("heapRetainers", () => {
  it("sums what each object alone keeps alive and names only code on the way to it", () => {
    // root → Holder.cache → Map → [0] array → [0] string; Holder also points at the string weakly.
    const node = (type: number, name: number, id: number, size: number, edges: number) => [
      type,
      name,
      id,
      size,
      edges,
    ];
    const retainers = heapRetainers(
      {
        snapshot: {
          meta: {
            node_fields: ["type", "name", "id", "self_size", "edge_count"],
            node_types: [["synthetic", "object", "array", "string"]],
            edge_fields: ["type", "name_or_index", "to_node"],
            edge_types: [["property", "element", "weak", "hidden"]],
          },
        },
        nodes: [
          ...node(0, 4, 1, 0, 1),
          ...node(1, 1, 3, 100, 2),
          ...node(1, 2, 5, 50, 1),
          ...node(2, 0, 7, 1_000, 1),
          ...node(3, 5, 9, 500, 0),
        ],
        edges: [0, 6, 5, 0, 3, 10, 2, 0, 20, 3, 0, 15, 1, 0, 20],
        strings: ["", "Holder", "Map", "cache", "(GC roots)", "a secret", "holder"],
      },
      0,
      0,
    );
    expect(retainers.get(5)).toEqual({
      retained: 1_550,
      dominator: 3,
      path: "holder → Holder.cache → Map",
    });
    expect(retainers.get(3)?.retained).toBe(1_650);
    expect(retainers.get(9)?.path).toBe("holder → Holder.cache → Map.[0] → (array).[0] → (string)");
  });
});

describe("retainerGrowth", () => {
  const at = (sizes: Record<number, number>) =>
    new Map(
      Object.entries(sizes).map(([id, retained]) => [
        Number(id),
        { retained, dominator: Number(id) === 3 ? undefined : 3, path: `node ${id}` },
      ]),
    );
  it("reports the deepest object holding the growth, and only growth at every snapshot", () => {
    const growth = retainerGrowth([
      at({ 3: 1_000_000, 5: 900_000, 7: 2_000_000 }),
      at({ 3: 3_000_000, 5: 2_900_000, 7: 4_000_000 }),
      at({ 3: 5_000_000, 5: 4_900_000, 7: 3_500_000 }),
    ]);
    expect(growth).toEqual([{ path: "node 5", MB: 4, retainedMB: 4.9 }]);
  });
  it("keeps an ancestor its reported descendant does not account for", () => {
    // A chain 1 → 2 → 3 growing by 7, 6 and 5 MB, and 4 under 1 growing by 2 MB.
    const chain = (scale: number) =>
      new Map(
        [
          [1, 7, undefined],
          [2, 6, 1],
          [3, 5, 2],
          [4, 2, 1],
        ].map(([id, mb, dominator]) => [
          id!,
          { retained: (10 + mb! * scale) * 1e6, dominator, path: `node ${id}` },
        ]),
      );
    expect(retainerGrowth([chain(0), chain(0.5), chain(1)]).map(({ path }) => path)).toEqual([
      "node 1",
      "node 3",
      "node 4",
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

describe("runAbRounds", () => {
  effectIt.effect("keeps the runs that finished when a later run fails", () =>
    Effect.gen(function* () {
      const files: Record<0 | 1, ReadonlyArray<string>> = { 0: [], 1: [] };
      const failure = yield* Effect.flip(
        runAbRounds({
          rounds: 3,
          outDir: "out",
          runSide: (side) => (side === 0 ? Effect.succeed("a1") : Effect.fail("b crashed")),
          save: (side, runs) => Effect.sync(() => (files[side] = [...runs])),
        }),
      );
      expect(failure).toBe("b crashed");
      expect(files).toEqual({ 0: ["a1"], 1: [] });
    }),
  );
});
