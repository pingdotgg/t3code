import { describe, expect, it } from "@effect/vitest";
import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

// ProcessDiagnostics treats process.pid as the server, so the fixture PID is an
// offset from it. A fixed PID collides whenever the test worker is assigned it.
const SERVER_PID = process.pid;
const CHILD_PID = SERVER_PID + 1;

function makeNativeSnapshot(
  processes: ResourceMonitorSnapshotEvent["processes"],
): ResourceMonitorSnapshotEvent {
  return {
    version: 3,
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

function layerTelemetryFor(
  snapshot: ResourceMonitorSnapshotEvent,
  desktopSnapshot?: DesktopHostTelemetrySnapshot,
) {
  const layerNative = NativeTelemetryClient.layerTest({
    sampleNow: Effect.succeed({ generation: 0, snapshot }),
    health: Effect.succeed({
      status: "healthy",
      hello: Option.none(),
      lastSampleAt: Option.some(DateTime.makeUnsafe(snapshot.sampledAtUnixMs)),
      lastError: Option.none(),
      restartCount: 0,
      sampleIntervalMs: 1_000,
    }),
  });
  const layerDesktop = desktopSnapshot
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
    Layer.provide(Layer.mergeAll(layerNative, layerDesktop, ResourceAttribution.layer)),
  );
}

describe("ProcessDiagnostics", () => {
  it.effect("rejects stale process identities before signaling", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([]);
      const layerTelemetry = layerTelemetryFor(snapshot);
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(layerTelemetry));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: CHILD_PID,
            startTimeMs: 2_000,
            signal: "SIGINT",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: CHILD_PID,
        signal: "SIGINT",
        signaled: false,
        message: Option.some(
          `Process ${CHILD_PID} no longer matches the selected process identity.`,
        ),
      });
    }),
  );

  it.effect("refuses to signal when a fresh identity check cannot be collected", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([
        {
          pid: CHILD_PID,
          ppid: SERVER_PID,
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
      const staleTelemetry = yield* Effect.service(ResourceTelemetry.ResourceTelemetry).pipe(
        Effect.flatMap((telemetry) => telemetry.latest),
        Effect.provide(layerTelemetryFor(snapshot)),
      );
      const layerTelemetry = Layer.succeed(
        ResourceTelemetry.ResourceTelemetry,
        ResourceTelemetry.ResourceTelemetry.of({
          latest: Effect.succeed(staleTelemetry),
          changes: Stream.empty,
          subscribe: Effect.die("unused"),
          readHistory: () => Effect.die("unused"),
          refresh: Effect.fail(
            new ResourceTelemetry.ResourceTelemetryRefreshFailed({
              operation: "refresh",
              cause: new Error("collector unavailable"),
            }),
          ),
          retry: Effect.die("unused"),
        }),
      );
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(layerTelemetry));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: CHILD_PID,
            startTimeMs: 2_000,
            signal: "SIGINT",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: CHILD_PID,
        signal: "SIGINT",
        signaled: false,
        message: Option.some(
          `Could not refresh process ${CHILD_PID}; refusing to signal a stale identity.`,
        ),
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
          pid: CHILD_PID,
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
      const layerTelemetry = layerTelemetryFor(snapshot, {
        version: 1,
        type: "desktopTelemetry",
        sequence: 1,
        sampledAtUnixMs,
        electronPid: CHILD_PID,
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
            pid: CHILD_PID,
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
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(layerTelemetry));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: CHILD_PID,
            startTimeMs: 2_000,
            signal: "SIGKILL",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: CHILD_PID,
        signal: "SIGKILL",
        signaled: false,
        message: Option.some(`Process ${CHILD_PID} is not a signalable T3 backend descendant.`),
      });

      const diagnostics = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) => processDiagnostics.read),
        Effect.provide(layer),
      );
      expect(diagnostics.processes).toEqual([]);
      expect(diagnostics.processCount).toBe(0);
      expect(diagnostics.totalCpuPercent).toBe(0);
      expect(diagnostics.totalRssBytes).toBe(0);
    }),
  );
});
