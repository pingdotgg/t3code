import type { HostPowerSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import {
  commitCollectionControlUpdate,
  synchronizeCollectionControlOnStart,
} from "./NativeTelemetryClient.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
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

describe("disabled native monitor", () => {
  it.effect("does not spawn on Windows, degrades requests, and stays disabled on retry", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawn = vi.fn(() => Effect.die("disabled monitor must not spawn"));
      yield* Effect.gen(function* () {
        const binary = yield* ResourceMonitorBinary.make();
        const client = yield* NativeTelemetryClient.make().pipe(
          Effect.provideService(ResourceMonitorBinary.ResourceMonitorBinary, binary),
        );
        const subscription = yield* client.subscribeHealth;
        if (subscription.latest.restartCount === 0) {
          yield* subscription.changes.pipe(
            Stream.filter((health) => health.restartCount > 0),
            Stream.runHead,
          );
        }
        const health = yield* client.health;
        expect(health.status).toBe("degraded");
        expect(Option.getOrNull(health.lastError)).toBe(
          "Native resource monitoring is disabled by server configuration.",
        );
        for (const request of [
          client.processTable.pipe(Effect.asVoid),
          client.sampleNow.pipe(Effect.asVoid),
          client.readHistory(1000).pipe(Effect.asVoid),
          client.capabilities.pipe(Effect.asVoid),
        ]) {
          const error = yield* Effect.flip(request);
          expect(error._tag).toBe("NativeTelemetryUnavailable");
        }
        const retrySubscription = yield* client.subscribeHealth;
        expect(yield* client.retry).toBe(true);
        yield* retrySubscription.changes.pipe(
          Stream.filter((next) => next.restartCount > health.restartCount),
          Stream.runHead,
        );
        expect(spawn).not.toHaveBeenCalled();
      }).pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          resourceMonitorEnabled: false,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, { ...spawner, spawn }),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {
          T3CODE_RESOURCE_MONITOR_PATH: "/override/monitor.exe",
        }),
      );
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-monitor-client-" })),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
