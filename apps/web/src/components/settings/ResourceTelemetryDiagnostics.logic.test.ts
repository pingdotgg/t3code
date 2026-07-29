import { describe, expect, it } from "vite-plus/test";

import type { ResourceTelemetryProcess } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
  shouldShowResourceMonitorRetry,
  visibleResourceTelemetryProcesses,
} from "./ResourceTelemetryDiagnostics.logic";

const process = (pid: number, ppid: number, depth: number): ResourceTelemetryProcess => ({
  identity: { pid, startTimeMs: pid * 1_000 },
  ppid,
  childPids: [],
  depth,
  name: `process-${pid}`,
  command: `process-${pid}`,
  status: "Running",
  category: pid === 1 ? "server" : "server-child",
  cpuPercent: 0,
  cpuTimeMs: 0,
  residentBytes: 0,
  peakResidentBytes: 0,
  virtualBytes: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  ioReadBytesPerSecond: 0,
  ioWriteBytesPerSecond: 0,
  ioSemantics: "storage",
  runTimeMs: 0,
  firstSeenAt: DateTime.makeUnsafe(0),
  lastSeenAt: DateTime.makeUnsafe(0),
});

describe("shouldShowResourceMonitorRetry", () => {
  it("allows retry when the initial telemetry request fails before a snapshot", () => {
    expect(
      shouldShowResourceMonitorRetry({
        nativeStatus: null,
        error: "Resource monitor is unavailable.",
      }),
    ).toBe(true);
  });

  it("does not show retry for an initial load without an error or a healthy snapshot", () => {
    expect(shouldShowResourceMonitorRetry({ nativeStatus: null, error: null })).toBe(false);
    expect(shouldShowResourceMonitorRetry({ nativeStatus: "healthy", error: null })).toBe(false);
  });
});

describe("resourceHistoryBarHeight", () => {
  it("renders an exactly zero sample with no visible bar", () => {
    expect(resourceHistoryBarHeight({ value: 0, max: 100, minimumVisiblePercent: 2 })).toBe(0);
  });

  it("keeps nonzero samples visible without changing proportional heights", () => {
    expect(resourceHistoryBarHeight({ value: 0.5, max: 100, minimumVisiblePercent: 2 })).toBe(2);
    expect(resourceHistoryBarHeight({ value: 50, max: 100, minimumVisiblePercent: 2 })).toBe(50);
  });
});

describe("resourceHistoryCpuScaleMax", () => {
  it("scales average bars independently of brief peak spikes", () => {
    const buckets = [
      { avgCpuPercent: 1, maxCpuPercent: 100 },
      { avgCpuPercent: 8, maxCpuPercent: 8 },
    ];
    expect(resourceHistoryCpuScaleMax(buckets)).toBe(8);
  });
});

describe("visibleResourceTelemetryProcesses", () => {
  it("hides descendants by parentage even when rows are not depth-first", () => {
    const processes = [
      process(1, 0, 0),
      process(10, 0, 0),
      process(2, 1, 1),
      process(11, 10, 1),
      process(3, 2, 2),
    ];

    expect(visibleResourceTelemetryProcesses(processes, new Set(["1:1000"]))).toEqual([
      processes[0],
      processes[1],
      processes[3],
    ]);
  });
});
