import type { HostPowerSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

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
