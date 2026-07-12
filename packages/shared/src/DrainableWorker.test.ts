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
  it.live("preserves ordering for items with the same key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker((key: string, item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }
            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
            }
            processed.push(`${key}:${item}`);
          }),
        );

        yield* worker.enqueue("thread-1", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("thread-1", "second");

        expect(yield* Deferred.isDone(secondStarted)).toBe(false);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);
        yield* worker.drain;

        expect(processed).toEqual(["thread-1:first", "thread-1:second"]);
      }),
    ),
  );

  it.live("does not let a blocked key prevent another key from progressing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const blockedStarted = yield* Deferred.make<void>();
        const releaseBlocked = yield* Deferred.make<void>();
        const otherProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker((key: string, _item: string) =>
          key === "blocked"
            ? Deferred.succeed(blockedStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseBlocked)),
              )
            : Deferred.succeed(otherProcessed, undefined),
        );

        yield* worker.enqueue("blocked", "never-completing");
        yield* Deferred.await(blockedStarted);
        yield* worker.enqueue("other", "runs-now");
        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );
        yield* Deferred.await(otherProcessed).pipe(Effect.timeout("1 second"));

        expect(yield* Deferred.isDone(otherProcessed)).toBe(true);
        expect(yield* Deferred.isDone(drained)).toBe(false);
        yield* Deferred.succeed(releaseBlocked, undefined);
        yield* Deferred.await(drained);
      }),
    ),
  );
});
