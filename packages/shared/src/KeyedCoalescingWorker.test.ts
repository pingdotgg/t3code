import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeKeyedCoalescingWorker } from "./KeyedCoalescingWorker.ts";

describe("makeKeyedCoalescingWorker", () => {
  it.live("coalesces a burst while draining all active and queued keys", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const otherStarted = yield* Deferred.make<void>();
        const releaseOther = yield* Deferred.make<void>();
        const processed: string[] = [];
        const worker = yield* makeKeyedCoalescingWorker({
          merge: (_current: number, next: number) => next,
          process: (key: string, value: number) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);
              if (value === 0) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              if (key === "other-turn") {
                yield* Deferred.succeed(otherStarted, undefined);
                yield* Deferred.await(releaseOther);
              }
            }),
        });
        yield* worker.enqueue("turn", 0);
        yield* Deferred.await(started);
        for (let index = 1; index <= 200; index++) yield* worker.enqueue("turn", index);
        yield* worker.enqueue("other-turn", 1);
        const drained = yield* Deferred.make<void>();
        const waiter = yield* worker.drain.pipe(
          Effect.andThen(Deferred.succeed(drained, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        expect(yield* Deferred.isDone(drained)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(otherStarted);
        expect(yield* Deferred.isDone(drained)).toBe(false);
        yield* Deferred.succeed(releaseOther, undefined);
        yield* Fiber.join(waiter);
        expect(processed).toEqual(["turn:0", "turn:200", "other-turn:1"]);
      }),
    ),
  );

  it.live("waits for latest work enqueued during active processing before draining the key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }

              if (value === "second") {
                yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSecond);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker
            .drainKey("terminal-1")
            .pipe(Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie))),
        );

        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
      }),
    ),
  );

  it.live("requeues pending work for a key after a processor failure and keeps draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFailure = yield* Deferred.make<void>();
        const secondProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFailure);
                return yield* Effect.fail("boom");
              }

              if (value === "second") {
                yield* Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* Deferred.await(secondProcessed);
        yield* worker.drainKey("terminal-1");

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
      }),
    ),
  );
});
