import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import { runManagedInstallationUpdate } from "./managedInstallationUpdate.ts";

const baseState: ProviderInstallState = {
  driver: ProviderDriverKind.make("antigravity"),
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: "1.5.14",
  canRemove: true,
  message: null,
};

describe("runManagedInstallationUpdate", () => {
  it.effect("forwards phase and throttled byte progress until the operation succeeds", () =>
    Effect.gen(function* () {
      const stateRef = yield* SubscriptionRef.make(baseState);
      const seen = yield* Queue.unbounded<ProviderInstallState>();
      const progress = yield* Queue.unbounded<string>();
      const installation = {
        start: SubscriptionRef.updateAndGet(stateRef, (current) => ({
          ...current,
          operationId: "op-1",
          phase: "downloading" as const,
          downloadedBytes: 0,
          totalBytes: 10_000_000,
          message: "Downloading Google's official Antigravity runtime.",
        })),
        changes: SubscriptionRef.changes(stateRef).pipe(
          Stream.tap((state) => Queue.offer(seen, state).pipe(Effect.asVoid)),
        ),
      };

      const running = yield* Effect.forkChild(
        runManagedInstallationUpdate(installation, (line) =>
          Queue.offer(progress, line).pipe(Effect.asVoid),
        ),
      );
      yield* Queue.take(seen);
      assert.strictEqual(
        yield* Queue.take(progress),
        "Downloading Google's official Antigravity runtime.",
      );

      // Within the 1s throttle window for the same phase, so this byte update is skipped.
      yield* TestClock.adjust("500 millis");
      yield* SubscriptionRef.update(stateRef, (current) => ({
        ...current,
        downloadedBytes: 2_500_000,
      }));
      yield* Queue.take(seen);

      // At the 1s throttle boundary (1000ms total), this byte update is emitted.
      yield* TestClock.adjust("500 millis");
      yield* SubscriptionRef.update(stateRef, (current) => ({
        ...current,
        downloadedBytes: 6_000_000,
      }));
      yield* Queue.take(seen);
      assert.strictEqual(yield* Queue.take(progress), "Downloading 6.0 MB of 10.0 MB");

      // Phase changes always publish immediately even within the 1s throttle window.
      yield* SubscriptionRef.update(stateRef, (current) => ({
        ...current,
        phase: "extracting" as const,
        message: "Extracting the verified runtime.",
      }));
      yield* Queue.take(seen);
      assert.strictEqual(yield* Queue.take(progress), "Extracting the verified runtime.");

      yield* SubscriptionRef.update(stateRef, (current) => ({
        ...current,
        phase: "succeeded" as const,
        installedVersion: "1.5.15",
        message: null,
      }));
      yield* Queue.take(seen);

      assert.deepStrictEqual(yield* Fiber.join(running), { status: "succeeded" });
      assert.strictEqual(yield* Queue.size(progress), 0);
    }),
  );

  it.effect("reports start failures, cancellations, and superseded operations", () =>
    Effect.gen(function* () {
      const startFailure = yield* runManagedInstallationUpdate(
        {
          start: Effect.fail({ message: "No network." }),
          changes: SubscriptionRef.changes(yield* SubscriptionRef.make(baseState)),
        },
        () => Effect.void,
      );
      assert.deepStrictEqual(startFailure, { status: "failed", message: "No network." });

      const cancelledRef = yield* SubscriptionRef.make(baseState);
      const cancelSubscribed = yield* Deferred.make<void>();
      const cancelledFiber = yield* Effect.forkChild(
        runManagedInstallationUpdate(
          {
            start: SubscriptionRef.updateAndGet(cancelledRef, (current) => ({
              ...current,
              operationId: "op-cancel",
              phase: "downloading" as const,
            })),
            changes: SubscriptionRef.changes(cancelledRef).pipe(
              Stream.tap(() => Deferred.succeed(cancelSubscribed, undefined)),
            ),
          },
          () => Effect.void,
        ),
      );
      yield* Deferred.await(cancelSubscribed);
      yield* SubscriptionRef.update(cancelledRef, (current) => ({
        ...current,
        phase: "cancelled" as const,
        message: "Installation cancelled.",
      }));
      assert.deepStrictEqual(yield* Fiber.join(cancelledFiber), {
        status: "failed",
        message: "Installation cancelled.",
      });

      const supersededRef = yield* SubscriptionRef.make(baseState);
      const supersededSubscribed = yield* Deferred.make<void>();
      const supersededFiber = yield* Effect.forkChild(
        runManagedInstallationUpdate(
          {
            start: SubscriptionRef.updateAndGet(supersededRef, (current) => ({
              ...current,
              operationId: "op-old",
              phase: "downloading" as const,
            })),
            changes: SubscriptionRef.changes(supersededRef).pipe(
              Stream.tap(() => Deferred.succeed(supersededSubscribed, undefined)),
            ),
          },
          () => Effect.void,
        ),
      );
      yield* Deferred.await(supersededSubscribed);
      yield* SubscriptionRef.update(supersededRef, (current) => ({
        ...current,
        operationId: "op-new",
        phase: "downloading" as const,
      }));
      assert.deepStrictEqual(yield* Fiber.join(supersededFiber), {
        status: "failed",
        message: "Provider installation changed while updating.",
      });
    }),
  );
});
