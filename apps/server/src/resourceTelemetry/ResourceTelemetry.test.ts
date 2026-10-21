import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorProcessSample,
  ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

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
  readonly externalProcesses?: ResourceMonitorSnapshotEvent["externalProcesses"];
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
    version: 3,
    type: "snapshot",
    sequence: input.sequence,
    sampledAtUnixMs: input.sampledAtUnixMs,
    collectionDurationMicros: 300,
    scannedProcessCount: 80,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 1,
    ...(input.externalProcesses === undefined
      ? {}
      : { externalProcesses: input.externalProcesses }),
    processes,
  };
}

function nativeGeneration(
  snapshot: ResourceMonitorSnapshotEvent,
  generation: number,
): NativeTelemetryClient.NativeTelemetrySnapshot {
  return { generation, snapshot };
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
  it.effect("replays churning history and retains baselines for returning processes", () =>
    Effect.gen(function* () {
      const readAtMs = DateTime.toEpochMillis(yield* DateTime.now);
      const sampleCount = 100;
      const samples = Array.from({ length: sampleCount }, (_, index) => {
        const sample = nativeSnapshot({
          sequence: index + 1,
          sampledAtUnixMs: readAtMs - (sampleCount - index) * 1_000,
          childCpuTimeMs: index * 10,
          childWriteBytes: index * 100,
        });
        const processes = sample.processes
          .filter((entry) => entry.pid === process.pid || entry.pid === 4_242)
          .map((entry) =>
            entry.pid === 4_242
              ? { ...entry, startTimeMs: index }
              : { ...entry, ioWriteBytes: index * 100 },
          );
        if (index === 0 || index === 2) {
          processes.push(
            processSample({
              pid: 4_243,
              ppid: process.pid,
              startTimeMs: 500,
              cpuTimeMs: index === 0 ? 100 : 350,
              ioWriteBytes: index === 0 ? 1_000 : 5_000,
            }),
          );
        }
        return { ...sample, processes };
      });
      const layerTelemetry = ResourceTelemetry.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NativeTelemetryClient.layerTest({ readHistory: () => Effect.succeed(samples) }),
            DesktopTelemetryReceiver.layerTest(),
            ResourceAttribution.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
        const history = yield* telemetry.readHistory({
          windowMs: sampleCount * 1_000,
          bucketMs: 10_000,
        });

        expect(history.topProcesses).toHaveLength(sampleCount + 2);
        expect(
          history.topProcesses.find((entry) => entry.identity.pid === process.pid),
        ).toMatchObject({
          sampleCount,
          cpuTimeMs: (sampleCount - 1) * 10,
          ioWriteBytes: (sampleCount - 1) * 100,
        });
        const children = history.topProcesses.filter((entry) => entry.identity.pid === 4_242);
        expect(children).toHaveLength(sampleCount);
        for (const child of children) {
          expect(child).toMatchObject({ sampleCount: 1, cpuTimeMs: 0, ioWriteBytes: 0 });
        }
        expect(history.topProcesses.find((entry) => entry.identity.pid === 4_243)).toMatchObject({
          sampleCount: 2,
          cpuTimeMs: 250,
          ioWriteBytes: 4_000,
        });
        expect(Math.max(...history.buckets.map((bucket) => bucket.maxProcessCount))).toBe(3);
        expect(history.buckets.reduce((total, bucket) => total + bucket.ioWriteBytes, 0)).toBe(
          (sampleCount - 1) * 100 + 4_000,
        );
      }).pipe(Effect.provide(layerTelemetry));
    }),
  );

  it.effect(
    "attributes an initial Electron root from the identity recorded by the native snapshot",
    () =>
      Effect.gen(function* () {
        const sampledAtUnixMs = DateTime.toEpochMillis(yield* DateTime.now);
        const sample = nativeSnapshot({
          sequence: 1,
          sampledAtUnixMs,
          childCpuTimeMs: 100,
          childWriteBytes: 1_000,
          externalProcesses: [{ pid: 5_000, startTimeMs: 300 }],
        });
        const desktop = {
          ...desktopSnapshot(sampledAtUnixMs),
          electronProcesses: [],
        };
        const layerNative = NativeTelemetryClient.layerTest({
          sampleNow: Effect.succeed(nativeGeneration(sample, 0)),
          health: Effect.succeed({
            status: "healthy",
            hello: Option.none(),
            lastSampleAt: Option.none(),
            lastError: Option.none(),
            restartCount: 0,
            sampleIntervalMs: 1_000,
          }),
        });
        const layerDesktop = DesktopTelemetryReceiver.layerTest({
          latest: Effect.succeedSome(desktop),
        });
        const layerTelemetry = ResourceTelemetry.layer.pipe(
          Layer.provide(Layer.mergeAll(layerNative, layerDesktop, ResourceAttribution.layer)),
        );

        const snapshot = yield* Effect.gen(function* () {
          const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
          return yield* telemetry.refresh;
        }).pipe(Effect.provide(layerTelemetry));

        expect(snapshot.processes.find((entry) => entry.identity.pid === 5_000)?.category).toBe(
          "electron-main",
        );
        expect(snapshot.groups.electron.processStarts).toBe(1);
        expect(snapshot.groups.backend.processStarts).toBe(3);
      }),
  );

  it.effect("rejects buffered snapshots from an earlier sidecar generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
        const stale = nativeSnapshot({
          sequence: 100,
          sampledAtUnixMs: startedAt + 1_000,
          childCpuTimeMs: 100,
          childWriteBytes: 1_000,
        });
        const current = nativeSnapshot({
          sequence: 1,
          sampledAtUnixMs: startedAt + 2_000,
          childCpuTimeMs: 200,
          childWriteBytes: 2_000,
        });
        const nativeSnapshots =
          yield* PubSub.unbounded<NativeTelemetryClient.NativeTelemetrySnapshot>();
        const layerNative = NativeTelemetryClient.layerTest({
          snapshots: Stream.fromPubSub(nativeSnapshots),
          sampleNow: Effect.never,
          health: Effect.succeed({
            status: "healthy",
            hello: Option.none(),
            lastSampleAt: Option.none(),
            lastError: Option.none(),
            restartCount: 1,
            sampleIntervalMs: 1_000,
          }),
        });
        const layerTelemetry = ResourceTelemetry.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerNative,
              DesktopTelemetryReceiver.layerTest(),
              ResourceAttribution.layer,
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
          const subscription = yield* telemetry.subscribe;
          const nextSnapshot = yield* Stream.runHead(subscription.changes).pipe(Effect.forkChild);

          yield* PubSub.publish(nativeSnapshots, nativeGeneration(stale, 0));
          yield* Effect.yieldNow;
          expect((yield* telemetry.latest).health.scannedProcessCount).toBe(0);

          yield* PubSub.publish(nativeSnapshots, nativeGeneration(current, 1));
          const received = yield* Fiber.join(nextSnapshot);

          expect(Option.isSome(received)).toBe(true);
          expect(DateTime.toEpochMillis(Option.getOrThrow(received).readAt)).toBe(
            current.sampledAtUnixMs,
          );
        }).pipe(Effect.provide(layerTelemetry));
      }),
    ),
  );

  it.effect("atomically subscribes while a desktop update is being rebuilt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
        const nextDesktopSnapshot = desktopSnapshot(startedAt + 1_000);
        const desktopChanges = yield* PubSub.unbounded<DesktopHostTelemetrySnapshot>();
        const rebuildStarted = yield* Deferred.make<void>();
        const finishRebuild = yield* Deferred.make<void>();
        const attributionReads = yield* Ref.make(0);
        const layerAttribution = Layer.succeed(
          ResourceAttribution.ResourceAttribution,
          ResourceAttribution.ResourceAttribution.of({
            record: () => Effect.void,
            snapshot: Ref.updateAndGet(attributionReads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.void
                  : Deferred.succeed(rebuildStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(finishRebuild)),
                    ),
              ),
              Effect.andThen(
                Effect.succeed({
                  readAt: DateTime.makeUnsafe(startedAt),
                  entries: [],
                }),
              ),
            ),
          }),
        );
        const layerNative = NativeTelemetryClient.layerTest({
          sampleNow: Effect.never,
          health: Effect.succeed({
            status: "healthy",
            hello: Option.none(),
            lastSampleAt: Option.none(),
            lastError: Option.none(),
            restartCount: 0,
            sampleIntervalMs: 1_000,
          }),
        });
        const layerDesktop = DesktopTelemetryReceiver.layerTest({
          changes: Stream.fromPubSub(desktopChanges),
        });
        const layerTelemetry = ResourceTelemetry.layer.pipe(
          Layer.provide(Layer.mergeAll(layerNative, layerDesktop, layerAttribution)),
        );

        yield* Effect.gen(function* () {
          const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
          yield* Effect.yieldNow;
          yield* PubSub.publish(desktopChanges, nextDesktopSnapshot);
          yield* Deferred.await(rebuildStarted);

          const subscriptionFiber = yield* telemetry.subscribe.pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(finishRebuild, undefined);
          const subscription = yield* Fiber.join(subscriptionFiber);

          expect(DateTime.toEpochMillis(subscription.latest.readAt)).toBe(
            nextDesktopSnapshot.sampledAtUnixMs,
          );
          expect(subscription.latest.power).toEqual(nextDesktopSnapshot.power);
        }).pipe(Effect.provide(layerTelemetry));
      }),
    ),
  );
});
