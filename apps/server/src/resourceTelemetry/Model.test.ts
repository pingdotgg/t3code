import {
  type DesktopElectronProcessMetric,
  type DesktopHostTelemetrySnapshot,
  type ResourceMonitorProcessSample,
  type ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { emptyTelemetryCounters, mergeProcesses, type MergeProcessesResult } from "./Model.ts";

const SERVER_PID = 100;
const BASE_TIME_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"));

function processSample(
  input: Partial<ResourceMonitorProcessSample> &
    Pick<ResourceMonitorProcessSample, "pid" | "ppid" | "startTimeMs">,
): ResourceMonitorProcessSample {
  return {
    runTimeMs: 1_000,
    name: `process-${input.pid}`,
    command: `process-${input.pid}`,
    status: "Running",
    cpuPercent: 0,
    cpuTimeMs: 0,
    residentBytes: 1_024,
    virtualBytes: 2_048,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioSemantics: "storage",
    ...input,
  };
}

function nativeSnapshot(
  sampledAtUnixMs: number,
  processes: ReadonlyArray<ResourceMonitorProcessSample>,
  sequence = 1,
): ResourceMonitorSnapshotEvent {
  return {
    version: 2,
    type: "snapshot",
    sequence,
    sampledAtUnixMs,
    collectionDurationMicros: 250,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes: [...processes],
  };
}

function electronMetric(
  input: Partial<DesktopElectronProcessMetric> &
    Pick<DesktopElectronProcessMetric, "pid" | "creationTimeMs" | "type">,
): DesktopElectronProcessMetric {
  return {
    cpuPercent: 0,
    idleWakeupsPerSecond: 0,
    workingSetBytes: 1_024,
    peakWorkingSetBytes: 2_048,
    ...input,
  };
}

function desktopSnapshot(
  sampledAtUnixMs: number,
  electronProcesses: ReadonlyArray<DesktopElectronProcessMetric>,
): DesktopHostTelemetrySnapshot {
  const sampledAt = DateTime.makeUnsafe(sampledAtUnixMs);
  return {
    version: 1,
    type: "desktopTelemetry",
    sequence: 1,
    sampledAtUnixMs,
    electronPid: electronProcesses[0]?.pid ?? 10_000,
    power: {
      source: "electron-main",
      idle: "false",
      idleSeconds: 0,
      locked: "false",
      suspended: false,
      onBattery: "false",
      lowPowerMode: "unknown",
      thermalState: "nominal",
      stale: false,
      updatedAt: sampledAt,
    },
    speedLimitPercent: Option.none(),
    electronProcesses: [...electronProcesses],
  };
}

function merge(input: {
  readonly native: ResourceMonitorSnapshotEvent;
  readonly desktop?: DesktopHostTelemetrySnapshot;
  readonly previous?: MergeProcessesResult;
  readonly sidecarPid?: number;
}): MergeProcessesResult {
  return mergeProcesses({
    serverPid: SERVER_PID,
    sidecarPid: Option.fromUndefinedOr(input.sidecarPid),
    fallbackSampledAtMs: input.native.sampledAtUnixMs,
    nativeSnapshot: Option.some(input.native),
    desktopSnapshot: Option.fromUndefinedOr(input.desktop),
    previous: input.previous?.previous ?? new Map(),
    counters: input.previous?.counters ?? emptyTelemetryCounters(),
    updatePrevious: true,
  });
}

describe("resource telemetry process model", () => {
  it("builds complete descendant depths and isolates monitor overhead", () => {
    const result = merge({
      sidecarPid: 900,
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 200, ppid: SERVER_PID, startTimeMs: 2_000 }),
        processSample({ pid: 201, ppid: 200, startTimeMs: 3_000 }),
        processSample({ pid: 202, ppid: 201, startTimeMs: 4_000 }),
        processSample({ pid: 900, ppid: SERVER_PID, startTimeMs: 5_000 }),
      ]),
    });

    expect(result.processes.map((process) => [process.identity.pid, process.depth])).toEqual([
      [100, 0],
      [200, 1],
      [201, 2],
      [202, 3],
      [900, 1],
    ]);
    expect(result.processes.find((process) => process.identity.pid === 900)?.category).toBe(
      "resource-monitor",
    );
    expect(result.groups.backend.processCount).toBe(4);
    expect(result.groups.monitor.processCount).toBe(1);
    expect(result.groups.monitor.processStarts).toBe(1);
    expect(result.groups.allT3.processStarts).toBe(5);
  });

  it("deduplicates Electron metrics and classifies Electron descendants", () => {
    const electronStart = 10_000;
    const result = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 300, ppid: 1, startTimeMs: electronStart }),
        processSample({ pid: 301, ppid: 300, startTimeMs: electronStart + 1 }),
      ]),
      desktop: desktopSnapshot(BASE_TIME_MS, [
        electronMetric({
          pid: 300,
          creationTimeMs: electronStart + 500,
          type: "Browser",
          name: "electron",
        }),
        electronMetric({
          pid: 301,
          creationTimeMs: electronStart + 500,
          type: "Utility",
          name: "network-service",
        }),
      ]),
    });

    expect(result.processes.filter((process) => process.identity.pid === 300)).toHaveLength(1);
    expect(result.processes.find((process) => process.identity.pid === 300)?.category).toBe(
      "electron-main",
    );
    expect(result.processes.find((process) => process.identity.pid === 301)?.category).toBe(
      "electron-utility",
    );
    expect(result.processes.find((process) => process.identity.pid === 301)?.depth).toBe(1);
    expect(result.groups.electron.processCount).toBe(2);
  });

  it("ignores stale Electron metrics after PID reuse", () => {
    const result = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 300, ppid: SERVER_PID, startTimeMs: 50_000 }),
      ]),
      desktop: desktopSnapshot(BASE_TIME_MS, [
        electronMetric({
          pid: 300,
          creationTimeMs: 10_000,
          type: "Browser",
        }),
      ]),
    });

    expect(result.processes.find((process) => process.identity.pid === 300)?.category).toBe(
      "server-child",
    );
    expect(result.groups.electron.processCount).toBe(0);
  });

  it("derives rates from cumulative counters and preserves I/O semantics", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
          ioReadBytes: 10_000,
          ioWriteBytes: 20_000,
          ioSemantics: "all-io",
        }),
      ]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 1_250,
            ioReadBytes: 12_000,
            ioWriteBytes: 23_000,
            ioSemantics: "all-io",
          }),
        ],
        2,
      ),
    });
    const server = second.processes[0]!;

    expect(server.cpuPercent).toBe(25);
    expect(server.ioReadBytesPerSecond).toBe(2_000);
    expect(server.ioWriteBytesPerSecond).toBe(3_000);
    expect(server.ioSemantics).toBe("all-io");
    expect(second.groups.backend.cpuTimeMs).toBe(250);
    expect(second.groups.backend.ioReadBytes).toBe(2_000);
    expect(second.groups.backend.ioWriteBytes).toBe(3_000);
  });

  it("derives deltas at the constrained 15-second sampling cadence", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
          ioReadBytes: 10_000,
          ioWriteBytes: 20_000,
        }),
      ]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 15_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 2_500,
            ioReadBytes: 25_000,
            ioWriteBytes: 50_000,
          }),
        ],
        2,
      ),
    });

    expect(second.processes[0]?.cpuPercent).toBe(10);
    expect(second.processes[0]?.ioReadBytesPerSecond).toBe(1_000);
    expect(second.processes[0]?.ioWriteBytesPerSecond).toBe(2_000);
    expect(second.groups.backend.cpuTimeMs).toBe(1_500);
    expect(second.groups.backend.ioReadBytes).toBe(15_000);
    expect(second.groups.backend.ioWriteBytes).toBe(30_000);
  });

  it("preserves native rates while applying a desktop-only update", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
          ioReadBytes: 10_000,
          ioWriteBytes: 20_000,
        }),
      ]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 1_250,
            ioReadBytes: 12_000,
            ioWriteBytes: 23_000,
          }),
        ],
        2,
      ),
    });
    const desktopOnly = mergeProcesses({
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      fallbackSampledAtMs: BASE_TIME_MS + 1_000,
      nativeSnapshot: Option.some(
        nativeSnapshot(
          BASE_TIME_MS + 1_000,
          [
            processSample({
              pid: SERVER_PID,
              ppid: 1,
              startTimeMs: 1_000,
              cpuTimeMs: 1_250,
              ioReadBytes: 12_000,
              ioWriteBytes: 23_000,
            }),
          ],
          2,
        ),
      ),
      desktopSnapshot: Option.some(desktopSnapshot(BASE_TIME_MS + 1_500, [])),
      previous: second.previous,
      counters: second.counters,
      updatePrevious: false,
    });

    expect(desktopOnly.processes[0]?.cpuPercent).toBe(25);
    expect(desktopOnly.processes[0]?.ioReadBytesPerSecond).toBe(2_000);
    expect(desktopOnly.processes[0]?.ioWriteBytesPerSecond).toBe(3_000);
  });

  it("resets deltas when counters decrease or the sampling gap is unsafe", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
          ioReadBytes: 10_000,
          ioWriteBytes: 20_000,
        }),
      ]),
    });
    const decreased = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 100,
            ioReadBytes: 100,
            ioWriteBytes: 200,
          }),
        ],
        2,
      ),
    });
    const delayed = merge({
      previous: decreased,
      native: nativeSnapshot(
        BASE_TIME_MS + 90_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 10_000,
            ioReadBytes: 100_000,
            ioWriteBytes: 200_000,
          }),
        ],
        3,
      ),
    });

    expect(decreased.processes[0]?.cpuPercent).toBe(0);
    expect(decreased.processes[0]?.ioReadBytesPerSecond).toBe(0);
    expect(decreased.processes[0]?.ioWriteBytesPerSecond).toBe(0);
    expect(delayed.processes[0]?.cpuPercent).toBe(0);
    expect(delayed.processes[0]?.ioReadBytesPerSecond).toBe(0);
    expect(delayed.processes[0]?.ioWriteBytesPerSecond).toBe(0);
    expect(delayed.groups.backend.cpuTimeMs).toBe(0);
    expect(delayed.groups.backend.ioReadBytes).toBe(0);
    expect(delayed.groups.backend.ioWriteBytes).toBe(0);
  });

  it("treats reused PIDs as an exit plus a new process", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 200, ppid: SERVER_PID, startTimeMs: 2_000 }),
      ]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
          processSample({
            pid: 200,
            ppid: SERVER_PID,
            startTimeMs: 9_000,
            cpuTimeMs: 999,
            ioReadBytes: 999,
            ioWriteBytes: 999,
          }),
        ],
        2,
      ),
    });
    const reused = second.processes.find((process) => process.identity.pid === 200)!;

    expect(reused.identity.startTimeMs).toBe(9_000);
    expect(reused.cpuPercent).toBe(0);
    expect(reused.ioReadBytesPerSecond).toBe(0);
    expect(second.groups.backend.processStarts).toBe(3);
    expect(second.groups.backend.processExits).toBe(1);
  });
});
