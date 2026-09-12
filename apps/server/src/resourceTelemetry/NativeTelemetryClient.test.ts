import {
  RESOURCE_MONITOR_PROTOCOL_VERSION,
  ResourceMonitorCommand as ResourceMonitorCommandSchema,
  ResourceMonitorEvent as ResourceMonitorEventSchema,
  type HostPowerSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import {
  canCommandNativeTelemetrySidecar,
  canRequestNativeTelemetryRetry,
  commitCollectionControlUpdate,
  layer as nativeTelemetryClientLayer,
  NativeTelemetryExited,
  retainRecentNativeTelemetryFailures,
  resolveNativeSampleIntervalMs,
  runPendingNativeTelemetryRequest,
  synchronizeCollectionControlOnStart,
  NativeTelemetryClient,
  type NativeTelemetryClientError,
} from "./NativeTelemetryClient.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

const basePower: HostPowerSnapshot = {
  source: "electron-main",
  idle: "false",
  idleSeconds: 0,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "false",
  thermalState: "nominal",
  stale: false,
  updatedAt: DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"),
};

const decodeMonitorCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(ResourceMonitorCommandSchema),
);
const encodeMonitorEvent = Schema.encodeSync(Schema.fromJsonString(ResourceMonitorEventSchema));

describe("resolveNativeSampleIntervalMs", () => {
  it("keeps a recovery cadence while suspended and backs off under host constraints", () => {
    expect(resolveNativeSampleIntervalMs({ ...basePower, suspended: true }, 1)).toBe(15_000);
    expect(resolveNativeSampleIntervalMs({ ...basePower, locked: "true" }, 1)).toBe(15_000);
    expect(resolveNativeSampleIntervalMs({ ...basePower, lowPowerMode: "true" }, 1)).toBe(15_000);
    expect(resolveNativeSampleIntervalMs({ ...basePower, thermalState: "critical" }, 1)).toBe(
      15_000,
    );
    expect(resolveNativeSampleIntervalMs({ ...basePower, onBattery: "true" }, 1)).toBe(5_000);
  });

  it("slows background telemetry and serves live diagnostics at 1Hz", () => {
    const unknown: HostPowerSnapshot = {
      ...basePower,
      source: "unknown",
      stale: true,
    };
    expect(resolveNativeSampleIntervalMs(unknown, 0)).toBe(5_000);
    expect(resolveNativeSampleIntervalMs(unknown, 1)).toBe(1_000);
    expect(
      resolveNativeSampleIntervalMs(
        { ...basePower, stale: true, locked: "true", suspended: true },
        0,
      ),
    ).toBe(5_000);
    expect(resolveNativeSampleIntervalMs(basePower, 0)).toBe(5_000);
    expect(resolveNativeSampleIntervalMs(basePower, 1)).toBe(1_000);
  });
});

describe("canRequestNativeTelemetryRetry", () => {
  it("only accepts retry while the supervisor is waiting without a live sidecar", () => {
    expect(canRequestNativeTelemetryRetry("degraded", false)).toBe(true);
    expect(canRequestNativeTelemetryRetry("unavailable", false)).toBe(true);
    expect(canRequestNativeTelemetryRetry("degraded", true)).toBe(false);
    expect(canRequestNativeTelemetryRetry("healthy", false)).toBe(false);
    expect(canRequestNativeTelemetryRetry("starting", false)).toBe(false);
  });
});

describe("canCommandNativeTelemetrySidecar", () => {
  it("keeps on-demand recovery commands available while a live sidecar is degraded", () => {
    expect(canCommandNativeTelemetrySidecar("healthy", true)).toBe(true);
    expect(canCommandNativeTelemetrySidecar("degraded", true)).toBe(true);
    expect(canCommandNativeTelemetrySidecar("unavailable", true)).toBe(false);
    expect(canCommandNativeTelemetrySidecar("degraded", false)).toBe(false);
  });
});

describe("retainRecentNativeTelemetryFailures", () => {
  it("expires old failures so an isolated crash restarts from the initial backoff", () => {
    expect(retainRecentNativeTelemetryFailures([0, 30_000], 90_001)).toEqual([]);
    expect(retainRecentNativeTelemetryFailures([30_000, 60_000], 90_000)).toEqual([30_000, 60_000]);
  });
});

describe("commitCollectionControlUpdate", () => {
  it.effect("retains desired demand and retries unapplied sidecar state", () =>
    Effect.gen(function* () {
      const initial = {
        hostPower: basePower,
        liveSubscriberCount: 0,
        sampleIntervalMs: 5_000,
      };
      const desired = yield* Ref.make(initial);
      const applied = yield* Ref.make(initial);
      const failure = new Error("sidecar write failed");
      const receivedStates: Array<readonly [number, number]> = [];

      const received = yield* commitCollectionControlUpdate(
        desired,
        applied,
        (current) => ({
          ...current,
          liveSubscriberCount: 1,
          sampleIntervalMs: 1_000,
        }),
        (previous, next) => {
          receivedStates.push([previous.sampleIntervalMs, next.sampleIntervalMs]);
          return Effect.fail(failure);
        },
      ).pipe(Effect.flip);

      expect(received).toBe(failure);
      expect(yield* Ref.get(desired)).toEqual({
        ...initial,
        liveSubscriberCount: 1,
        sampleIntervalMs: 1_000,
      });
      expect(yield* Ref.get(applied)).toEqual(initial);

      yield* commitCollectionControlUpdate(
        desired,
        applied,
        (current) => current,
        (previous, next) => {
          receivedStates.push([previous.sampleIntervalMs, next.sampleIntervalMs]);
          return Effect.void;
        },
      );
      expect(receivedStates).toEqual([
        [5_000, 1_000],
        [5_000, 1_000],
      ]);
      expect(yield* Ref.get(applied)).toEqual(yield* Ref.get(desired));
    }),
  );

  it.effect("serializes startup synchronization with runtime control updates", () =>
    Effect.gen(function* () {
      const initial = {
        hostPower: basePower,
        liveSubscriberCount: 0,
        sampleIntervalMs: 5_000,
      };
      const desired = yield* Ref.make(initial);
      const applied = yield* Ref.make(initial);
      const ready = yield* Ref.make(false);
      const mutex = yield* Semaphore.make(1);
      const startupApplying = yield* Deferred.make<void>();
      const releaseStartup = yield* Deferred.make<void>();
      const appliedIntervals: Array<number> = [];

      const startupFiber = yield* synchronizeCollectionControlOnStart(
        mutex,
        desired,
        applied,
        (control) =>
          Effect.sync(() => {
            appliedIntervals.push(control.sampleIntervalMs);
          }).pipe(
            Effect.andThen(Deferred.succeed(startupApplying, undefined)),
            Effect.andThen(Deferred.await(releaseStartup)),
            Effect.asVoid,
          ),
        Ref.set(ready, true),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(startupApplying);

      const updateFiber = yield* mutex
        .withPermits(1)(
          commitCollectionControlUpdate(
            desired,
            applied,
            (current) => ({
              ...current,
              liveSubscriberCount: 1,
              sampleIntervalMs: 1_000,
            }),
            (_previous, next) =>
              Effect.gen(function* () {
                expect(yield* Ref.get(ready)).toBe(true);
                appliedIntervals.push(next.sampleIntervalMs);
              }),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(desired)).toEqual(initial);

      yield* Deferred.succeed(releaseStartup, undefined);
      yield* Fiber.join(startupFiber);
      yield* Fiber.join(updateFiber);

      expect(appliedIntervals).toEqual([5_000, 1_000]);
      expect(yield* Ref.get(applied)).toEqual(yield* Ref.get(desired));
    }),
  );
});

describe("runPendingNativeTelemetryRequest", () => {
  const makePending = () =>
    Ref.make<Map<string, Deferred.Deferred<number, NativeTelemetryClientError>>>(new Map());

  const waitForPending = (
    pending: Ref.Ref<Map<string, Deferred.Deferred<number, NativeTelemetryClientError>>>,
  ) =>
    Effect.gen(function* () {
      while ((yield* Ref.get(pending)).size === 0) yield* Effect.yieldNow;
      return [...(yield* Ref.get(pending)).values()][0]!;
    });

  it.effect("returns a direct response and removes the pending request", () =>
    Effect.gen(function* () {
      const pending = yield* makePending();
      const fiber = yield* runPendingNativeTelemetryRequest({
        pending,
        requestId: "response",
        operation: "processTable",
        timeout: Duration.seconds(5),
        write: Effect.void,
      }).pipe(Effect.forkChild);
      yield* Deferred.succeed(yield* waitForPending(pending), 42);

      expect(yield* Fiber.join(fiber)).toBe(42);
      expect((yield* Ref.get(pending)).size).toBe(0);
    }),
  );

  it.effect("times out and removes the pending request", () =>
    Effect.gen(function* () {
      const pending = yield* makePending();
      const fiber = yield* runPendingNativeTelemetryRequest({
        pending,
        requestId: "timeout",
        operation: "windowsListeners",
        timeout: Duration.seconds(5),
        write: Effect.void,
      }).pipe(Effect.flip, Effect.forkChild);
      yield* waitForPending(pending);
      yield* TestClock.adjust(Duration.seconds(5));

      expect((yield* Fiber.join(fiber))._tag).toBe("NativeTelemetryRequestTimedOut");
      expect((yield* Ref.get(pending)).size).toBe(0);
    }),
  );

  it.effect("removes an interrupted pending request", () =>
    Effect.gen(function* () {
      const pending = yield* makePending();
      const fiber = yield* runPendingNativeTelemetryRequest({
        pending,
        requestId: "interrupted",
        operation: "processTable",
        timeout: Duration.seconds(5),
        write: Effect.void,
      }).pipe(Effect.forkChild);
      yield* waitForPending(pending);
      yield* Fiber.interrupt(fiber);

      expect((yield* Ref.get(pending)).size).toBe(0);
    }),
  );

  it.effect("accepts a new request after a restart fails the old one", () =>
    Effect.gen(function* () {
      const pending = yield* makePending();
      const first = yield* runPendingNativeTelemetryRequest({
        pending,
        requestId: "before-restart",
        operation: "processTable",
        timeout: Duration.seconds(5),
        write: Effect.void,
      }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.fail(
        yield* waitForPending(pending),
        new NativeTelemetryExited({ exitCode: 1 }),
      );
      expect((yield* Fiber.join(first))._tag).toBe("NativeTelemetryExited");

      const second = yield* runPendingNativeTelemetryRequest({
        pending,
        requestId: "after-restart",
        operation: "processTable",
        timeout: Duration.seconds(5),
        write: Effect.void,
      }).pipe(Effect.forkChild);
      yield* Deferred.succeed(yield* waitForPending(pending), 7);
      expect(yield* Fiber.join(second)).toBe(7);
      expect((yield* Ref.get(pending)).size).toBe(0);
    }),
  );
});

describe("NativeTelemetryClient", () => {
  it.effect("fails an in-flight request when the sidecar exits and serves the replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstRequest = yield* Deferred.make<void>();
        const firstReady = yield* Deferred.make<void>();
        const secondSpawned = yield* Deferred.make<void>();
        const secondReady = yield* Deferred.make<void>();
        const firstExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        let spawnCount = 0;

        const spawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const instance = spawnCount++;
            const events = yield* Queue.unbounded<Uint8Array>();
            const hello = encodeMonitorEvent({
              version: RESOURCE_MONITOR_PROTOCOL_VERSION,
              type: "hello",
              sidecarVersion: "test",
              sidecarPid: instance + 1,
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
            });
            const stdin = Sink.forEach((chunk: Uint8Array) =>
              Effect.gen(function* () {
                const command = decodeMonitorCommand(new TextDecoder().decode(chunk));
                if (command.type === "configure") {
                  yield* Deferred.succeed(instance === 0 ? firstReady : secondReady, undefined);
                }
                if (command.type !== "processTable") return;
                if (instance === 0) {
                  yield* Deferred.succeed(firstRequest, undefined);
                  return;
                }
                yield* Queue.offer(
                  events,
                  new TextEncoder().encode(
                    `${encodeMonitorEvent({
                      version: RESOURCE_MONITOR_PROTOCOL_VERSION,
                      type: "processTable",
                      requestId: command.requestId,
                      processes: [{ pid: 42, ppid: 1, name: "replacement-child" }],
                    })}\n`,
                  ),
                );
              }),
            );
            if (instance === 1) yield* Deferred.succeed(secondSpawned, undefined);
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(instance + 1),
              exitCode: instance === 0 ? Deferred.await(firstExit) : Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin,
              stdout: Stream.concat(
                Stream.encodeText(Stream.make(`${hello}\n`)),
                Stream.fromQueue(events),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const dependencies = Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-telemetry-client-test-" }),
          Layer.succeed(
            ResourceMonitorBinary.ResourceMonitorBinary,
            ResourceMonitorBinary.ResourceMonitorBinary.of({
              resolve: Effect.succeed("test-sidecar"),
            }),
          ),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        const context = yield* Layer.build(
          nativeTelemetryClientLayer.pipe(Layer.provide(dependencies)),
        );
        const client = yield* Effect.service(NativeTelemetryClient).pipe(Effect.provide(context));

        yield* Deferred.await(firstReady);
        yield* client.capabilities;
        const first = yield* client.processTable.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(firstRequest);
        yield* Deferred.succeed(firstExit, ChildProcessSpawner.ExitCode(1));
        expect((yield* Fiber.join(first))._tag).toBe("NativeTelemetryExited");

        yield* TestClock.adjust(Duration.millis(500));
        yield* Deferred.await(secondSpawned);
        yield* Deferred.await(secondReady);

        expect(yield* client.processTable).toEqual([
          { pid: 42, ppid: 1, name: "replacement-child" },
        ]);
      }),
    ),
  );
});
