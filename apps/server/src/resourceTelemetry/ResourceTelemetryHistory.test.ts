import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorProcessSample,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryHealth,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  buildResourceTelemetryHistory,
  normalizeResourceTelemetryHistoryInput,
} from "./ResourceTelemetryHistory.ts";

const SERVER_PID = 100;
const ELECTRON_PID = 200;
const CHILD_PID = 300;
const STARTED_AT_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"));

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

function snapshot(
  sequence: number,
  sampledAtUnixMs: number,
  childCpuTimeMs: number,
  childWriteBytes: number,
): ResourceMonitorSnapshotEvent {
  const processes = [
    processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 10 }),
    processSample({
      pid: ELECTRON_PID,
      ppid: 1,
      startTimeMs: 20,
      name: "electron",
      command: "electron",
    }),
    processSample({
      pid: CHILD_PID,
      ppid: SERVER_PID,
      startTimeMs: 30,
      name: "codex",
      command: "codex app-server",
      cpuTimeMs: childCpuTimeMs,
      ioWriteBytes: childWriteBytes,
    }),
  ];
  return {
    version: 2,
    type: "snapshot",
    sequence,
    sampledAtUnixMs,
    collectionDurationMicros: 100,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes,
  };
}

const health: ResourceTelemetryHealth = {
  native: {
    status: "healthy",
    lastSampleAt: Option.none(),
    lastError: Option.none(),
  },
  desktop: {
    status: "healthy",
    lastSampleAt: Option.none(),
    lastError: Option.none(),
  },
  sidecarVersion: Option.some("0.1.0"),
  sidecarPid: Option.some(400),
  restartCount: 0,
  collectionDurationMicros: 100,
  scannedProcessCount: 3,
  retainedProcessCount: 3,
  inaccessibleProcessCount: 0,
};

function desktopSnapshot(): DesktopHostTelemetrySnapshot {
  const sampledAt = DateTime.makeUnsafe(STARTED_AT_MS + 1_000);
  return {
    version: 1,
    type: "desktopTelemetry",
    sequence: 1,
    sampledAtUnixMs: STARTED_AT_MS + 1_000,
    electronPid: ELECTRON_PID,
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
    electronProcesses: [
      {
        pid: ELECTRON_PID,
        creationTimeMs: 20,
        type: "Browser",
        cpuPercent: 999,
        idleWakeupsPerSecond: 999,
        workingSetBytes: 999_999,
        peakWorkingSetBytes: 999_999,
      },
    ],
  };
}

describe("buildResourceTelemetryHistory", () => {
  it("normalizes query bounds before requesting native history", () => {
    expect(normalizeResourceTelemetryHistoryInput({ windowMs: 0, bucketMs: 0 })).toEqual({
      windowMs: 1_000,
      bucketMs: 1_000,
    });
  });

  it("replays native snapshots on demand without applying current Electron metrics", () => {
    const history = buildResourceTelemetryHistory({
      readAt: DateTime.makeUnsafe(STARTED_AT_MS + 2_000),
      windowMs: 10_000,
      bucketMs: 10_000,
      sampleIntervalMs: 1_000,
      serverPid: SERVER_PID,
      sidecarPid: Option.some(400),
      desktopSnapshot: Option.some(desktopSnapshot()),
      snapshots: [
        snapshot(1, STARTED_AT_MS, 100, 1_000),
        snapshot(2, STARTED_AT_MS + 1_000, 350, 5_000),
      ],
      health,
    });

    const child = history.topProcesses.find((process) => process.identity.pid === CHILD_PID);
    const electron = history.topProcesses.find((process) => process.identity.pid === ELECTRON_PID);
    expect(child?.sampleCount).toBe(2);
    expect(child?.cpuTimeMs).toBe(250);
    expect(child?.ioWriteBytes).toBe(4_000);
    expect(electron?.category).toBe("electron-main");
    expect(electron?.currentRssBytes).toBe(1_024);
    expect(history.buckets.reduce((total, bucket) => total + bucket.ioWriteBytes, 0)).toBe(4_000);
  });
});
