// @effect-diagnostics nodeBuiltinImport:off - Lifecycle coverage launches one exact disposable child process.
import * as NodeChildProcess from "node:child_process";
import { assert, describe, it } from "@effect/vitest";
import type {
  ResourceMonitorProcessSample,
  ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";

import {
  characterizeObserverOverhead,
  classifyResourceSnapshot,
  deriveProcessFamilyMetrics,
  processIdentityMatches,
  resourceMonitorConfiguration,
  stopOwnedResourceMonitorProcess,
  validateResourceCadence,
  type DeclaredProcessRoot,
  type ObservedResourceSnapshot,
} from "./process-metrics.ts";

function processSample(
  input: Pick<ResourceMonitorProcessSample, "pid" | "ppid" | "startTimeMs"> &
    Partial<ResourceMonitorProcessSample>,
): ResourceMonitorProcessSample {
  return {
    runTimeMs: 1_000,
    name: `process-${input.pid}`,
    command: `process-${input.pid}`,
    status: "Run",
    cpuPercent: 0,
    cpuTimeMs: 0,
    residentBytes: 0,
    virtualBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioSemantics: "storage",
    ...input,
  };
}

function observed(
  monotonicTimeMs: number,
  processes: ReadonlyArray<ResourceMonitorProcessSample>,
  sequence = monotonicTimeMs,
): ObservedResourceSnapshot {
  const snapshot: ResourceMonitorSnapshotEvent = {
    version: 2,
    type: "snapshot",
    sequence,
    sampledAtUnixMs: 1_700_000_000_000 + monotonicTimeMs,
    collectionDurationMicros: 2_000,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes,
  };
  return { monotonicTimeMs, snapshot };
}

const roots: ReadonlyArray<DeclaredProcessRoot> = [
  {
    identity: { pid: 100, startTimeMs: 1_000 },
    ownership: "app",
    kind: "electron-main",
    label: "T3 Electron main",
  },
  {
    identity: { pid: 200, startTimeMs: 2_000 },
    ownership: "app",
    kind: "server",
    label: "T3 server",
  },
  {
    identity: { pid: 800, startTimeMs: 8_000 },
    ownership: "harness",
    kind: "replay-provider",
    label: "deterministic replay provider",
  },
  {
    identity: { pid: 900, startTimeMs: 9_000 },
    ownership: "harness",
    kind: "observer",
    label: "standalone resource observer",
  },
];

describe("process-family benchmark metrics", () => {
  it("configures the native protocol with app roots and never harness roots", () => {
    assert.deepStrictEqual(
      resourceMonitorConfiguration({
        roots,
        primaryRoot: roots[0]!,
        sampleIntervalMs: 250,
      }),
      {
        version: 2,
        type: "configure",
        rootPid: 100,
        sampleIntervalMs: 250,
        externalProcesses: [{ pid: 200, startTimeMs: 2_000 }],
      },
    );
  });

  it("includes all app descendants and excludes explicit harness trees", () => {
    const snapshot = classifyResourceSnapshot(
      observed(250, [
        processSample({ pid: 100, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 101, ppid: 100, startTimeMs: 1_010, name: "renderer" }),
        processSample({ pid: 102, ppid: 100, startTimeMs: 1_020, name: "gpu" }),
        processSample({ pid: 200, ppid: 1, startTimeMs: 2_000 }),
        processSample({ pid: 201, ppid: 200, startTimeMs: 2_010, name: "terminal" }),
        processSample({ pid: 202, ppid: 200, startTimeMs: 2_020, name: "resource-monitor" }),
        processSample({ pid: 800, ppid: 1, startTimeMs: 8_000 }),
        processSample({ pid: 801, ppid: 800, startTimeMs: 8_010 }),
        processSample({ pid: 900, ppid: 1, startTimeMs: 9_000 }),
      ]),
      roots,
    );

    assert.deepStrictEqual(
      snapshot.included.map(({ process }) => process.pid),
      [100, 101, 102, 200, 201, 202],
    );
    assert.deepStrictEqual(
      snapshot.excluded.map(({ process }) => process.pid),
      [800, 801, 900],
    );
    assert.deepStrictEqual(snapshot.unknown, []);
  });

  it("does not transfer ownership across PID reuse", () => {
    const snapshot = classifyResourceSnapshot(
      observed(250, [processSample({ pid: 100, ppid: 1, startTimeMs: 99_000 })]),
      roots,
    );

    assert.equal(snapshot.included.length, 0);
    assert.equal(snapshot.unknown.length, 1);
    assert.deepStrictEqual(snapshot.identityFailures, [
      "PID 100 was declared with a different start time (observed 99000)",
    ]);
  });

  it("normalizes only within the documented coarse start-time bucket", () => {
    assert.equal(
      processIdentityMatches({ pid: 100, startTimeMs: 1_000 }, { pid: 100, startTimeMs: 1_999 }),
      true,
    );
    assert.equal(
      processIdentityMatches({ pid: 100, startTimeMs: 1_000 }, { pid: 100, startTimeMs: 2_000 }),
      false,
    );
    assert.equal(
      processIdentityMatches({ pid: 101, startTimeMs: 1_000 }, { pid: 100, startTimeMs: 1_000 }),
      false,
    );
  });

  it("invalidates an unattributed helper instead of silently dropping it", () => {
    const metrics = deriveProcessFamilyMetrics({
      roots,
      samples: [
        observed(250, [
          processSample({ pid: 100, ppid: 1, startTimeMs: 1_000, residentBytes: 100 }),
          processSample({ pid: 700, ppid: 1, startTimeMs: 7_000, residentBytes: 1_000 }),
        ]),
      ],
    });

    assert.equal(metrics.valid, false);
    assert.deepStrictEqual(metrics.reasons, ["process 700:7000 has no declared ownership"]);
    assert.equal(metrics.peakResidentBytes, 100);
  });

  it("preserves clear invalid evidence when the monitor produced no samples", () => {
    const metrics = deriveProcessFamilyMetrics({ roots, samples: [] });
    assert.equal(metrics.valid, false);
    assert.deepStrictEqual(metrics.reasons, ["no resource samples were collected"]);
  });

  it("derives sampled peak RSS and quiescent whole-family CPU p95", () => {
    const samples = [
      observed(250, [
        processSample({
          pid: 100,
          ppid: 1,
          startTimeMs: 1_000,
          residentBytes: 100,
          cpuPercent: 2,
        }),
        processSample({
          pid: 101,
          ppid: 100,
          startTimeMs: 1_010,
          residentBytes: 200,
          cpuPercent: 3,
        }),
      ]),
      observed(1_250, [
        processSample({
          pid: 100,
          ppid: 1,
          startTimeMs: 1_000,
          residentBytes: 400,
          cpuPercent: 8,
        }),
        processSample({
          pid: 101,
          ppid: 100,
          startTimeMs: 1_010,
          residentBytes: 300,
          cpuPercent: 2,
        }),
      ]),
    ];

    const metrics = deriveProcessFamilyMetrics({
      roots,
      samples,
      quiescentWindow: { startTimeMs: 0, endTimeMs: 2_000 },
    });
    assert.equal(metrics.valid, true);
    assert.equal(metrics.peakResidentBytes, 700);
    assert.equal(metrics.quiescentCpuP95Pct, 9.75);
    assert.equal(metrics.processCountPeak, 2);
    assert.deepStrictEqual(metrics.ioSemantics, ["storage"]);
  });

  it("validates requested versus achieved cadence and monitor failures", () => {
    const complete = validateResourceCadence({
      samples: [0, 250, 500, 750].map((time) => observed(time, [])),
      requestedIntervalMs: 250,
      windowStartTimeMs: 0,
      windowEndTimeMs: 1_000,
    });
    assert.equal(complete.valid, true);
    assert.equal(complete.coverageRatio, 1);
    assert.equal(complete.achievedIntervalMs, 250);

    const degraded = validateResourceCadence({
      samples: [observed(0, []), observed(750, [])],
      requestedIntervalMs: 250,
      windowStartTimeMs: 0,
      windowEndTimeMs: 1_000,
      monitorErrors: ["native monitor unavailable"],
    });
    assert.equal(degraded.valid, false);
    assert.deepStrictEqual(degraded.reasons, [
      "fewer than 95% of expected resource samples arrived",
      "a resource sample gap exceeded twice the requested cadence",
      "resource monitor error: native monitor unavailable",
    ]);
  });

  it("enforces observer overhead limits without subtracting overhead", () => {
    const acceptable = characterizeObserverOverhead({
      observerCpuPercent: [0.2, 0.3, 0.5, 0.7],
      collectionDurationMicros: [1_000, 2_000, 3_000, 4_000],
      requestedIntervalMs: 250,
    });
    assert.equal(acceptable.valid, true);
    assert.ok(Math.abs(acceptable.cpuP95Pct - 0.67) < 0.000_001);
    assert.ok(Math.abs(acceptable.collectionDurationP95Ms - 3.85) < 0.000_001);
    assert.deepStrictEqual(acceptable.reasons, []);

    const excessive = characterizeObserverOverhead({
      observerCpuPercent: [1.1, 1.2],
      collectionDurationMicros: [70_000, 80_000],
      requestedIntervalMs: 250,
    });
    assert.equal(excessive.valid, false);
    assert.deepStrictEqual(excessive.reasons, [
      "observer p95 CPU exceeded 1% of one logical core",
      "observer collection p95 reached 25% of the requested cadence",
    ]);
  });

  it("bounds graceful, SIGTERM, and SIGKILL cleanup for a stubborn exact child", async () => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        [
          "process.stdin.resume()",
          'process.on("SIGTERM", () => {})',
          'process.stdout.write("ready\\n")',
        ].join(";"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });

    const startedAt = performance.now();
    await stopOwnedResourceMonitorProcess(child, () => child.stdin.write("shutdown\n"), {
      gracefulMs: 20,
      terminateMs: 20,
      killMs: 500,
    });

    assert.equal(child.signalCode, "SIGKILL");
    assert.ok(performance.now() - startedAt < 1_000);
  });
});
