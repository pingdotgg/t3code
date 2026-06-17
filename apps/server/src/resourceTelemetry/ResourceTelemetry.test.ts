import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorProcessSample,
  ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopTelemetryReceiver from "./DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import * as ResourceAttribution from "./ResourceAttribution.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";

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

function nativeSnapshot(input: {
  readonly sequence: number;
  readonly sampledAtUnixMs: number;
  readonly childCpuTimeMs: number;
  readonly childWriteBytes: number;
}): ResourceMonitorSnapshotEvent {
  const processes = [
    processSample({
      pid: process.pid,
      ppid: 1,
      startTimeMs: 100,
      cpuTimeMs: input.sequence * 10,
    }),
    processSample({
      pid: 4_242,
      ppid: process.pid,
      startTimeMs: 200,
      name: "codex",
      command: "codex app-server",
      cpuTimeMs: input.childCpuTimeMs,
      ioWriteBytes: input.childWriteBytes,
    }),
    processSample({
      pid: 5_000,
      ppid: 1,
      startTimeMs: 300,
      name: "electron",
      command: "electron",
      cpuTimeMs: input.sequence * 20,
    }),
    processSample({
      pid: 9_000,
      ppid: process.pid,
      startTimeMs: 400,
      name: "t3-resource-monitor",
      command: "t3-resource-monitor",
      cpuTimeMs: input.sequence * 5,
    }),
  ];
  return {
    version: 2,
    type: "snapshot",
    sequence: input.sequence,
    sampledAtUnixMs: input.sampledAtUnixMs,
    collectionDurationMicros: 300,
    scannedProcessCount: 80,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 1,
    processes,
  };
}

function desktopSnapshot(sampledAtUnixMs: number): DesktopHostTelemetrySnapshot {
  const sampledAt = DateTime.makeUnsafe(sampledAtUnixMs);
  return {
    version: 1,
    type: "desktopTelemetry",
    sequence: 1,
    sampledAtUnixMs,
    electronPid: 5_000,
    power: {
      source: "electron-main",
      idle: "false",
      idleSeconds: 2,
      locked: "false",
      suspended: false,
      onBattery: "true",
      lowPowerMode: "unknown",
      thermalState: "fair",
      stale: false,
      updatedAt: sampledAt,
    },
    speedLimitPercent: Option.some(90),
    electronProcesses: [
      {
        pid: 5_000,
        creationTimeMs: 300,
        type: "Browser",
        name: "electron",
        cpuPercent: 2,
        cumulativeCpuSeconds: 0.02,
        idleWakeupsPerSecond: 3,
        workingSetBytes: 4_096,
        peakWorkingSetBytes: 8_192,
      },
    ],
  };
}

describe("ResourceTelemetry", () => {
  it.effect("enables live native and Electron collection only while changes are retained", () =>
    Effect.gen(function* () {
      const sampledAtUnixMs = DateTime.toEpochMillis(yield* DateTime.now);
      const sample = nativeSnapshot({
        sequence: 1,
        sampledAtUnixMs,
        childCpuTimeMs: 100,
        childWriteBytes: 1_000,
      });
      const demandChanges = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const nativeLayer = NativeTelemetryClient.layerTest({
        sampleNow: Effect.succeed(sample),
        health: Effect.succeed({
          status: "healthy",
          hello: Option.none(),
          lastSampleAt: Option.none(),
          lastError: Option.none(),
          restartCount: 0,
          sampleIntervalMs: 1_000,
        }),
      });
      const desktopLayer = DesktopTelemetryReceiver.layerTest({
        latest: Effect.succeedSome(desktopSnapshot(sampledAtUnixMs)),
        setDiagnosticsDemand: (enabled) =>
          Ref.update(demandChanges, (changes) => [...changes, enabled]),
      });
      const telemetryLayer = ResourceTelemetry.layer.pipe(
        Layer.provide(Layer.mergeAll(nativeLayer, desktopLayer, ResourceAttribution.layer)),
      );

      const live = yield* Stream.runHead(
        Effect.gen(function* () {
          const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
          return telemetry.changes;
        }).pipe(Stream.unwrap),
      ).pipe(Effect.provide(telemetryLayer));

      expect(Option.isSome(live)).toBe(true);
      expect(yield* Ref.get(demandChanges)).toEqual([true, false]);
    }),
  );

  it.effect("combines native, Electron, attribution, retry, and history data", () =>
    Effect.gen(function* () {
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const samples = [
        nativeSnapshot({
          sequence: 1,
          sampledAtUnixMs: startedAt,
          childCpuTimeMs: 100,
          childWriteBytes: 1_000,
        }),
        nativeSnapshot({
          sequence: 2,
          sampledAtUnixMs: startedAt + 1_000,
          childCpuTimeMs: 350,
          childWriteBytes: 5_000,
        }),
        nativeSnapshot({
          sequence: 1,
          sampledAtUnixMs: startedAt + 2_000,
          childCpuTimeMs: 500,
          childWriteBytes: 7_000,
        }),
      ] as const;
      const sampleIndex = yield* Ref.make(0);
      const externalProcesses = yield* Ref.make<
        ReadonlyArray<{ readonly pid: number; readonly startTimeMs?: number }>
      >([]);
      const retryCount = yield* Ref.make(0);
      const nativeHealth = yield* Ref.make<NativeTelemetryClient.NativeTelemetryClientHealth>({
        status: "healthy",
        hello: Option.some({
          version: 2,
          type: "hello",
          sidecarVersion: "0.1.0",
          sidecarPid: 9_000,
          platform: "test",
          arch: "test",
          capabilities: {
            cumulativeCpuTime: true,
            currentCpuPercent: true,
            residentMemory: true,
            virtualMemory: true,
            ioBytes: true,
            processStartTime: true,
            processTree: true,
          },
        }),
        lastSampleAt: Option.some(DateTime.makeUnsafe(startedAt)),
        lastError: Option.none(),
        restartCount: 2,
        sampleIntervalMs: 1_000,
      });
      const nativeHealthChanges =
        yield* PubSub.sliding<NativeTelemetryClient.NativeTelemetryClientHealth>(4);
      const nativeLayer = NativeTelemetryClient.layerTest({
        setExternalProcesses: (processes) => Ref.set(externalProcesses, processes),
        readHistory: () => Effect.succeed(samples.slice(0, 2)),
        sampleNow: Ref.modify(sampleIndex, (index) => [
          samples[Math.min(index, samples.length - 1)]!,
          index + 1,
        ]),
        retry: Ref.updateAndGet(retryCount, (count) => count + 1).pipe(Effect.as(true)),
        health: Ref.get(nativeHealth),
        healthChanges: Stream.fromPubSub(nativeHealthChanges),
      });
      const desktopLayer = DesktopTelemetryReceiver.layerTest({
        latest: Effect.succeedSome(desktopSnapshot(startedAt)),
        health: Effect.succeed({
          status: "healthy",
          lastSampleAt: Option.some(DateTime.makeUnsafe(startedAt)),
          lastError: Option.none(),
        }),
      });
      const attributionLayer = ResourceAttribution.layer;
      const dependencies = Layer.mergeAll(nativeLayer, desktopLayer, attributionLayer);
      const telemetryLayer = ResourceTelemetry.layer.pipe(Layer.provide(dependencies));
      const layer = Layer.mergeAll(dependencies, telemetryLayer);

      yield* Effect.gen(function* () {
        const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
        const attribution = yield* ResourceAttribution.ResourceAttribution;

        expect(yield* Ref.get(externalProcesses)).toEqual([{ pid: 5_000 }]);

        yield* attribution.record({
          component: "provider-event-log",
          operation: "append",
          logicalWriteBytes: 512,
          count: 2,
          durationMs: 4,
        });
        const first = yield* telemetry.refresh;
        expect(first.groups.backend.processCount).toBe(2);
        expect(first.groups.electron.processCount).toBe(1);
        expect(first.groups.monitor.processCount).toBe(1);
        expect(first.power.onBattery).toBe("true");
        expect(Option.getOrNull(first.speedLimitPercent)).toBe(90);
        expect(first.attribution.entries).toEqual([
          {
            component: "provider-event-log",
            operation: "append",
            logicalReadBytes: 0,
            logicalWriteBytes: 512,
            count: 2,
            durationMs: 4,
          },
        ]);

        yield* TestClock.adjust(Duration.seconds(1));
        const second = yield* telemetry.refresh;
        const codex = second.processes.find((entry) => entry.identity.pid === 4_242);
        expect(codex?.cpuPercent).toBe(25);
        expect(codex?.ioWriteBytesPerSecond).toBe(4_000);
        expect(second.groups.backend.ioWriteBytes).toBe(4_000);
        expect(second.health.collectionDurationMicros).toBe(300);
        expect(second.health.scannedProcessCount).toBe(80);
        expect(second.health.inaccessibleProcessCount).toBe(1);

        const history = yield* telemetry.readHistory({
          windowMs: 60_000,
          bucketMs: 10_000,
        });
        expect(history.retainedSampleCount).toBeGreaterThan(0);
        expect(
          history.topProcesses.find((entry) => entry.identity.pid === 4_242)?.sampleCount,
        ).toBe(2);
        expect(history.topProcesses.find((entry) => entry.identity.pid === 4_242)?.cpuTimeMs).toBe(
          250,
        );
        expect(
          history.topProcesses.find((entry) => entry.identity.pid === 4_242)?.ioWriteBytes,
        ).toBe(4_000);
        expect(history.buckets.reduce((total, bucket) => total + bucket.ioWriteBytes, 0)).toBe(
          4_000,
        );

        const retry = yield* telemetry.retry;
        expect(retry.accepted).toBe(true);
        expect(yield* Ref.get(retryCount)).toBe(1);

        yield* Ref.update(nativeHealth, (current) => ({
          ...current,
          hello: Option.map(current.hello, (hello) => ({
            ...hello,
            sidecarPid: 9_001,
          })),
          restartCount: 3,
        }));
        yield* TestClock.adjust(Duration.seconds(1));
        const restarted = yield* telemetry.refresh;
        expect(DateTime.toEpochMillis(restarted.readAt)).toBe(startedAt + 2_000);
        expect(Option.getOrNull(restarted.health.sidecarPid)).toBe(9_001);

        yield* Ref.update(nativeHealth, (current) => ({
          ...current,
          status: "degraded" as const,
          lastError: Option.some("collector exited"),
        }));
        yield* PubSub.publish(nativeHealthChanges, yield* Ref.get(nativeHealth));
        yield* Effect.yieldNow;
        const healthUpdate = yield* telemetry.latest;
        expect(healthUpdate.health.native.status).toBe("degraded");
        expect(Option.getOrNull(healthUpdate.health.native.lastError)).toBe("collector exited");
        const degradedHistory = yield* telemetry.readHistory({
          windowMs: 60_000,
          bucketMs: 10_000,
        });
        expect(degradedHistory.health.native.status).toBe("degraded");
      }).pipe(Effect.provide(layer));
    }),
  );
});
