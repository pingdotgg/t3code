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
  it.live("does not let a blocked key delay other keys and keeps per-key order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const slowStarted = yield* Deferred.make<void>();
        const releaseSlow = yield* Deferred.make<void>();
        const otherDone = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker(
          (item: { key: string; name: string }) =>
            Effect.gen(function* () {
              if (item.name === "slow") {
                yield* Deferred.succeed(slowStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSlow);
              }
              processed.push(item.name);
              if (item.name === "other") {
                yield* Deferred.succeed(otherDone, undefined).pipe(Effect.orDie);
              }
            }),
          (item) => item.key,
          // One lane per key keeps the test independent of hash collisions.
          1024,
        );

        yield* worker.enqueue({ key: "thread-a", name: "slow" });
        yield* Deferred.await(slowStarted);
        yield* worker.enqueue({ key: "thread-a", name: "after-slow" });
        yield* worker.enqueue({ key: "thread-b", name: "other" });

        yield* Deferred.await(otherDone);
        expect(processed).toEqual(["other"]);

        yield* Deferred.succeed(releaseSlow, undefined);
        yield* worker.drain;
        expect(processed).toEqual(["other", "slow", "after-slow"]);
      }),
    ),
  );
});
