import type { HostPowerSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import { ChildProcessSpawner } from "effect/process";
import type { ResourceMonitorCommand, ResourceMonitorSnapshotEvent } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

import {
  commitCollectionControlUpdate,
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

// Each request id must differ so samples resolve their own pending request.
const testRandom = () => {
  let call = 0;
  return SecureRandom.make((size) => new Uint8Array(size).fill(++call % 256));
};

it.effect("shares demand, stops after the last request, and retains history across visits", () =>
  Effect.gen(function* () {
    let starts = 0;
    let stops = 0;
    const streaming = yield* Queue.unbounded<void>();
    const spawned = yield* Queue.unbounded<void>();
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        starts++;
        yield* Queue.offer(spawned, undefined);
        const output = yield* Queue.unbounded<string>();
        const history: ResourceMonitorSnapshotEvent[] = [];
        const send = (event: unknown) => Queue.offer(output, `${JSON.stringify(event)}\n`);
        yield* send({
          version: 3,
          type: "hello",
          sidecarVersion: "test",
          sidecarPid: starts,
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
        });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(starts),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () =>
            Effect.sync(() => {
              stops++;
            }),
          unref: Effect.succeed(Effect.void),
          stdout: Stream.fromQueue(output).pipe(Stream.encodeText),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          stdin: Sink.forEach((bytes: Uint8Array) =>
            Effect.gen(function* () {
              const command = JSON.parse(new TextDecoder().decode(bytes)) as ResourceMonitorCommand;
              if (command.type === "setStreaming" && command.enabled)
                yield* Queue.offer(streaming, undefined);
              if (command.type === "sampleNow") {
                const snapshot: ResourceMonitorSnapshotEvent = {
                  version: 3,
                  type: "snapshot",
                  sequence: history.length + 1,
                  sampledAtUnixMs: DateTime.toEpochMillis(yield* DateTime.now),
                  collectionDurationMicros: 1,
                  scannedProcessCount: 0,
                  retainedProcessCount: 0,
                  inaccessibleProcessCount: 0,
                  processes: [],
                };
                history.push(snapshot);
                yield* send({ ...snapshot, requestId: command.requestId });
              }
              if (command.type === "processTable")
                yield* send({
                  version: 3,
                  type: "processTable",
                  requestId: command.requestId,
                  processes: [],
                });
              if (command.type === "readHistory")
                yield* send({
                  version: 3,
                  type: "historyChunk",
                  requestId: command.requestId,
                  done: true,
                  snapshots: history,
                });
            }),
          ),
        });
      }),
    );
    const client = yield* NativeTelemetryClient.make().pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "resource-demand-" })),
      Effect.provideService(ResourceMonitorBinary.ResourceMonitorBinary, {
        resolve: Effect.succeed("monitor"),
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    expect(starts).toBe(0);
    expect(yield* client.processTable).toEqual([]);
    expect([starts, stops]).toEqual([1, 1]);
    const visit = yield* Scope.make();
    yield* client.snapshots.pipe(Stream.runDrain, Effect.forkIn(visit));
    yield* Queue.take(streaming);
    const first = yield* client.sampleNow;
    expect([starts, stops]).toEqual([2, 1]);
    const otherVisit = yield* Scope.make();
    const healthChanges = yield* client.subscribeHealth;
    const nextHealth = yield* Stream.toPull(healthChanges.changes);
    yield* client.snapshots.pipe(Stream.runDrain, Effect.forkIn(otherVisit));
    yield* nextHealth;
    yield* Scope.close(visit, Exit.void);
    expect(stops).toBe(1);
    yield* Scope.close(otherVisit, Exit.void);
    expect(stops).toBe(2);
    expect(
      (yield* client.readHistory(60_000)).map((snapshot) => [
        snapshot.sequence,
        snapshot.sidecarPid,
      ]),
    ).toEqual([[1, 2]]);
    expect([starts, stops]).toEqual([3, 3]);
    const next = yield* client.sampleNow;
    expect(next.generation).toBeGreaterThan(first.generation);
    expect((yield* client.readHistory(60_000)).map((snapshot) => snapshot.sequence)).toEqual([
      1, 1,
    ]);
    expect(starts).toBe(stops);
    yield* Queue.takeAll(spawned);
    const exportScope = yield* Scope.make();
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "resource-export-" })),
    );
    const exported = yield* NativeTelemetryClient.make().pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        ...config,
        otlpMetricsUrl: "http://localhost:4318",
      }),
      Effect.provideService(ResourceMonitorBinary.ResourceMonitorBinary, {
        resolve: Effect.succeed("monitor"),
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Scope.Scope, exportScope),
    );
    yield* Queue.take(spawned);
    const exportHealth = yield* exported.subscribeHealth;
    if (exportHealth.latest.status !== "healthy") {
      yield* exportHealth.changes.pipe(
        Stream.filter((health) => health.status === "healthy"),
        Stream.runHead,
      );
    }
    const started = starts;
    expect(started).toBe(stops + 1);
    yield* exported.sampleNow;
    yield* exported.processTable;
    expect(starts).toBe(started);
    expect(stops).toBe(started - 1);
    expect(yield* exported.readHistory(60_000)).toHaveLength(1);
    yield* Scope.close(exportScope, Exit.void);
    expect(starts).toBe(stops);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(SecureRandom.SecureRandom, testRandom()),
  ),
);

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
