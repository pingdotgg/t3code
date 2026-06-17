import { describe, expect, it } from "@effect/vitest";
import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

function makeNativeSnapshot(
  processes: ResourceMonitorSnapshotEvent["processes"],
): ResourceMonitorSnapshotEvent {
  return {
    version: 2,
    type: "snapshot",
    sequence: 1,
    sampledAtUnixMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-05-05T10:00:00.000Z")),
    collectionDurationMicros: 250,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes,
  };
}

function makeTelemetryLayer(
  snapshot: ResourceMonitorSnapshotEvent,
  desktopSnapshot?: DesktopHostTelemetrySnapshot,
) {
  const nativeLayer = NativeTelemetryClient.layerTest({
    sampleNow: Effect.succeed(snapshot),
    health: Effect.succeed({
      status: "healthy",
      hello: Option.none(),
      lastSampleAt: Option.some(DateTime.makeUnsafe(snapshot.sampledAtUnixMs)),
      lastError: Option.none(),
      restartCount: 0,
      sampleIntervalMs: 1_000,
    }),
  });
  const desktopLayer = desktopSnapshot
    ? DesktopTelemetryReceiver.layerTest({
        latest: Effect.succeedSome(desktopSnapshot),
        health: Effect.succeed({
          status: "healthy",
          lastSampleAt: Option.some(DateTime.makeUnsafe(desktopSnapshot.sampledAtUnixMs)),
          lastError: Option.none(),
        }),
      })
    : DesktopTelemetryReceiver.layerTest();
  return ResourceTelemetry.layer.pipe(
    Layer.provide(Layer.mergeAll(nativeLayer, desktopLayer, ResourceAttribution.layer)),
  );
}

describe("ProcessDiagnostics", () => {
  it.effect("projects live process data from resource telemetry", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([
        {
          pid: process.pid,
          ppid: 1,
          startTimeMs: 1_000,
          runTimeMs: 60_000,
          name: "node",
          command: "t3 server",
          status: "Running",
          cpuPercent: 0,
          cpuTimeMs: 100,
          residentBytes: 1_024,
          virtualBytes: 2_048,
          ioReadBytes: 100,
          ioWriteBytes: 200,
          ioSemantics: "storage",
        },
        {
          pid: 4_242,
          ppid: process.pid,
          startTimeMs: 2_000,
          runTimeMs: 4_000,
          name: "agent",
          command: "codex app-server",
          status: "Running",
          cpuPercent: 1.5,
          cpuTimeMs: 60,
          residentBytes: 2_048,
          virtualBytes: 4_096,
          ioReadBytes: 300,
          ioWriteBytes: 400,
          ioSemantics: "storage",
        },
      ]);
      const telemetryLayer = makeTelemetryLayer(snapshot);
      const layer = ProcessDiagnostics.layer.pipe(Layer.provideMerge(telemetryLayer));

      const diagnostics = yield* Effect.gen(function* () {
        const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
        const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
        yield* telemetry.refresh;
        return yield* processDiagnostics.read;
      }).pipe(Effect.provide(layer));

      expect(diagnostics.processes.map((process) => process.pid)).toEqual([4242]);
      expect(diagnostics.processes[0]?.startTimeMs).toBe(2_000);
      expect(diagnostics.processes[0]?.cpuPercent).toBe(1.5);
      expect(diagnostics.processes[0]?.rssBytes).toBe(2_048);
    }),
  );

  it.effect("rejects stale process identities before signaling", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([]);
      const telemetryLayer = makeTelemetryLayer(snapshot);
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(telemetryLayer));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: 4_242,
            startTimeMs: 2_000,
            signal: "SIGINT",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: 4242,
        signal: "SIGINT",
        signaled: false,
        message: Option.some("Process 4242 no longer matches the selected process identity."),
      });
    }),
  );

  it.effect("rejects Electron processes as signal targets", () =>
    Effect.gen(function* () {
      const sampledAtUnixMs = DateTime.toEpochMillis(
        DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
      );
      const snapshot = makeNativeSnapshot([
        {
          pid: 4_242,
          ppid: 1,
          startTimeMs: 2_000,
          runTimeMs: 4_000,
          name: "electron",
          command: "electron",
          status: "Running",
          cpuPercent: 1.5,
          cpuTimeMs: 60,
          residentBytes: 2_048,
          virtualBytes: 4_096,
          ioReadBytes: 300,
          ioWriteBytes: 400,
          ioSemantics: "storage",
        },
      ]);
      const sampledAt = DateTime.makeUnsafe(sampledAtUnixMs);
      const telemetryLayer = makeTelemetryLayer(snapshot, {
        version: 1,
        type: "desktopTelemetry",
        sequence: 1,
        sampledAtUnixMs,
        electronPid: 4_242,
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
            pid: 4_242,
            creationTimeMs: 2_000,
            type: "Browser",
            name: "electron",
            cpuPercent: 1.5,
            idleWakeupsPerSecond: 0,
            workingSetBytes: 2_048,
            peakWorkingSetBytes: 2_048,
          },
        ],
      });
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(telemetryLayer));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: 4_242,
            startTimeMs: 2_000,
            signal: "SIGKILL",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: 4_242,
        signal: "SIGKILL",
        signaled: false,
        message: Option.some("Process 4242 is not a signalable T3 backend descendant."),
      });
    }),
  );
});
