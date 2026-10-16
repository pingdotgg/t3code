import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { HostPowerSnapshot } from "@t3tools/contracts";
import {
  RESOURCE_MONITOR_PROTOCOL_VERSION,
  ResourceMonitorCommand,
  type ResourceMonitorHelloEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";
import {
  canCommandNativeTelemetrySidecar,
  canRequestNativeTelemetryRetry,
  commitCollectionControlUpdate,
  retainRecentNativeTelemetryFailures,
  resolveNativeSampleIntervalMs,
  synchronizeCollectionControlOnStart,
} from "./NativeTelemetryClient.ts";

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

  it("stops timed sampling without a live subscriber and serves live diagnostics at 1Hz", () => {
    const unknown: HostPowerSnapshot = {
      ...basePower,
      source: "unknown",
      stale: true,
    };
    expect(resolveNativeSampleIntervalMs(unknown, 0)).toBe(0);
    expect(resolveNativeSampleIntervalMs(unknown, 1)).toBe(1_000);
    expect(resolveNativeSampleIntervalMs({ ...basePower, locked: "true" }, 0)).toBe(0);
    expect(resolveNativeSampleIntervalMs({ ...basePower, onBattery: "true" }, 0)).toBe(0);
    expect(resolveNativeSampleIntervalMs(basePower, 0)).toBe(0);
    expect(resolveNativeSampleIntervalMs(basePower, 1)).toBe(1_000);
  });
});

const decodeCommandLine = Schema.decodeUnknownSync(Schema.fromJsonString(ResourceMonitorCommand));

const hello: ResourceMonitorHelloEvent = {
  version: RESOURCE_MONITOR_PROTOCOL_VERSION,
  type: "hello",
  sidecarVersion: "test",
  sidecarPid: 4242,
  platform: "linux",
  arch: "x64",
  capabilities: {
    cumulativeCpuTime: true,
    currentCpuPercent: true,
    residentMemory: true,
    virtualMemory: true,
    ioBytes: true,
    processStartTime: true,
    processTree: true,
  },
};

describe("NativeTelemetryClient", () => {
  it.effect("asks the sidecar for timed samples only while a live subscriber exists", () =>
    Effect.gen(function* () {
      const commands = yield* Queue.unbounded<ResourceMonitorCommand>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(hello.sidecarPid),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((chunk: Uint8Array) =>
              Effect.forEach(new TextDecoder().decode(chunk).split("\n").filter(Boolean), (line) =>
                Queue.offer(commands, decodeCommandLine(line)),
              ),
            ),
            stdout: Stream.encodeText(Stream.make(`${JSON.stringify(hello)}\n`)).pipe(
              Stream.concat(Stream.never),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const client = yield* NativeTelemetryClient.make().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorBinary, {
          resolve: Effect.succeed("/test/t3-resource-monitor"),
        }),
      );

      const configure = yield* Queue.take(commands);
      expect(configure).toMatchObject({ type: "configure", sampleIntervalMs: 0 });
      expect(yield* Queue.take(commands)).toMatchObject({ type: "setExternalProcesses" });

      const live = yield* Scope.make();
      yield* client.snapshots.pipe(Stream.runDrain, Effect.forkIn(live));
      expect(yield* Queue.take(commands)).toMatchObject({
        type: "setSampleInterval",
        sampleIntervalMs: 1_000,
      });
      expect(yield* Queue.take(commands)).toMatchObject({ type: "setStreaming", enabled: true });

      yield* Scope.close(live, Exit.void);
      expect(yield* Queue.take(commands)).toMatchObject({
        type: "setSampleInterval",
        sampleIntervalMs: 0,
      });
      expect(yield* Queue.take(commands)).toMatchObject({ type: "setStreaming", enabled: false });
      expect((yield* client.health).sampleIntervalMs).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-telemetry-test-" }),
          NodeCrypto.layer,
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );
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
