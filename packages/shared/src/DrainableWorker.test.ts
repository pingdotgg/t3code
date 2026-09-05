import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeDrainableWorker, makeKeyedDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makeKeyedDrainableWorker", () => {
  it.live("runs different keys independently while preserving each key's FIFO", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const worker = yield* makeKeyedDrainableWorker(
          (item: { readonly key: string; readonly value: string }) => item.key,
          (item) =>
            Effect.gen(function* () {
              if (item.value === "a1") {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
              processed.push(item.value);
              if (item.value === "b1") {
                yield* Deferred.succeed(secondStarted, undefined);
              }
            }),
        );

        yield* worker.enqueue({ key: "a", value: "a1" });
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue({ key: "a", value: "a2" });
        yield* worker.enqueue({ key: "b", value: "b1" });
        yield* Deferred.await(secondStarted);
        expect(processed).toEqual(["b1"]);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;
        expect(processed).toEqual(["b1", "a1", "a2"]);
      }),
    ),
  );

  it.live("drains work offered during drain, including new keys and follow-ups", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const a1Started = yield* Deferred.make<void>();
        const releaseA1 = yield* Deferred.make<void>();
        const b1Started = yield* Deferred.make<void>();
        const releaseB1 = yield* Deferred.make<void>();
        const c1Started = yield* Deferred.make<void>();
        const releaseC1 = yield* Deferred.make<void>();
        const worker = yield* makeKeyedDrainableWorker(
          (item: { readonly key: string; readonly value: string }) => item.key,
          (item) =>
            Effect.gen(function* () {
              if (item.value === "a1") {
                yield* Deferred.succeed(a1Started, undefined);
                yield* Deferred.await(releaseA1);
              }
              if (item.value === "b1") {
                yield* Deferred.succeed(b1Started, undefined);
                yield* Deferred.await(releaseB1);
              }
              if (item.value === "c1") {
                yield* Deferred.succeed(c1Started, undefined);
                yield* Deferred.await(releaseC1);
              }
              processed.push(item.value);
            }),
        );

        yield* worker.enqueue({ key: "a", value: "a1" });
        yield* worker.enqueue({ key: "b", value: "b1" });
        yield* Deferred.await(a1Started);
        yield* Deferred.await(b1Started);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        // Let the forked drain snapshot lanes [a, b]: no other work can be
        // enqueued while this fiber only yields, so after ample scheduler
        // turns the drain is parked waiting on the blocked a1/b1 lanes.
        // (Scheduler turns only — no wall-clock.)
        for (let i = 0; i < 50; i++) {
          yield* Effect.yieldNow;
        }

        // Offer a follow-up on existing lane "a" (a1 still blocked, so the
        // lane entry is stable and cannot be cleaned up mid-race) plus a
        // brand-new blocked key "c" — both strictly after the snapshot.
        // A snapshot-only drain never waits on "c", so it settles once
        // a/b release while c1 is still pending.
        yield* worker.enqueue({ key: "a", value: "a2" });
        yield* worker.enqueue({ key: "c", value: "c1" });
        yield* Deferred.await(c1Started);
        expect(yield* Deferred.isDone(drained)).toBe(false);

        // Releasing a/b must not settle the drain while c1 is pending.
        yield* Deferred.succeed(releaseA1, undefined);
        yield* Deferred.succeed(releaseB1, undefined);
        // Give the drain ample scheduler turns to (incorrectly) settle: the
        // quiescent drain stays pending regardless of turns taken since c1
        // is still blocked.
        for (let i = 0; i < 50; i++) {
          yield* Effect.yieldNow;
        }
        expect(processed).not.toContain("c1");
        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseC1, undefined);
        yield* Deferred.await(drained);
        expect(processed.toSorted()).toEqual(["a1", "a2", "b1", "c1"]);
      }),
    ),
  );

  it.live("creates a single lane under concurrent same-key enqueues", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: number[] = [];
        const processingFibers: number[] = [];
        // Hold every item until all enqueues have been offered, so the lane
        // can neither drain nor be cleaned up mid-race.
        const gate = yield* Deferred.make<void>();
        const worker = yield* makeKeyedDrainableWorker(
          (_item: number) => "shared",
          (item) =>
            Effect.gen(function* () {
              processingFibers.push(yield* Effect.fiberId);
              yield* Deferred.await(gate);
              processed.push(item);
            }),
        );

        const count = 50;
        yield* Effect.all(
          Array.from({ length: count }, (_, index) => worker.enqueue(index)),
          { concurrency: "unbounded", discard: true },
        );
        yield* Deferred.succeed(gate, undefined);
        yield* worker.drain;

        expect(processed).toHaveLength(count);
        expect(processed.toSorted((a, b) => a - b)).toEqual(
          Array.from({ length: count }, (_, index) => index),
        );
        expect(new Set(processingFibers).size).toBe(1);
      }),
    ),
  );
});
