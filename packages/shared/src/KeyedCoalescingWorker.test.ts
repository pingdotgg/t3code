import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makeKeyedCoalescingWorker } from "./KeyedCoalescingWorker.ts";

describe("makeKeyedCoalescingWorker", () => {
  it.effect("flushes during cooldown while the next normal dequeue remains rate-limited", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstProcessed = yield* Deferred.make<void>();
        const flushedProcessed = yield* Deferred.make<void>();
        const secondProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          cooldown: "250 millis",
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              if (key === "first" && value === "initial") {
                yield* Deferred.succeed(firstProcessed, undefined).pipe(Effect.orDie);
                return;
              }
              if (key === "first") {
                yield* Deferred.succeed(flushedProcessed, undefined).pipe(Effect.orDie);
                return;
              }
              yield* Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie);
            }),
        });

        yield* worker.enqueue("first", "initial");
        yield* Deferred.await(firstProcessed);
        yield* Effect.yieldNow;

        yield* worker.enqueue("first", "terminal-snapshot");
        yield* worker.enqueue("second", "queued-during-cooldown");
        yield* worker.flushKey("first");

        expect(yield* Deferred.isDone(flushedProcessed)).toBe(true);
        expect(yield* Deferred.isDone(secondProcessed)).toBe(false);
        yield* TestClock.adjust("249 millis");
        expect(yield* Deferred.isDone(secondProcessed)).toBe(false);
        yield* TestClock.adjust("1 millis");
        yield* Deferred.await(secondProcessed);
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

  it.live("flushes one key without waiting behind unrelated queued work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const slowStarted = yield* Deferred.make<void>();
        const releaseSlow = yield* Deferred.make<void>();
        const urgentStarted = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value, context) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}:${context.flush ? "flush" : "normal"}`);
              if (key === "slow") {
                yield* Deferred.succeed(slowStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSlow);
              }
              if (key === "urgent") {
                yield* Deferred.succeed(urgentStarted, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("slow", "first");
        yield* Deferred.await(slowStarted);
        yield* worker.enqueue("queued", "second");
        yield* worker.enqueue("urgent", "terminal");

        const flushed = yield* Effect.forkChild(worker.flushKey("urgent"));
        yield* Deferred.await(urgentStarted);

        expect(processed).toEqual(["slow:first:normal", "urgent:terminal:flush"]);

        yield* Fiber.join(flushed);
        yield* Deferred.succeed(releaseSlow, undefined);
        yield* worker.drainKey("queued");

        expect(processed).toEqual([
          "slow:first:normal",
          "urgent:terminal:flush",
          "queued:second:normal",
        ]);
      }),
    ),
  );

  it.live("does not process the same key concurrently when flushing queued work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const blockerStarted = yield* Deferred.make<void>();
        const releaseBlocker = yield* Deferred.make<void>();
        const firstFlushStarted = yield* Deferred.make<void>();
        const releaseFirstFlush = yield* Deferred.make<void>();
        const secondFlushStarted = yield* Deferred.make<void>();
        const afterStarted = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              if (key === "blocker") {
                yield* Deferred.succeed(blockerStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseBlocker);
              }

              if (key === "target" && value === "first") {
                yield* Deferred.succeed(firstFlushStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirstFlush);
              }

              if (key === "target" && value === "second") {
                yield* Deferred.succeed(secondFlushStarted, undefined).pipe(Effect.orDie);
              }

              if (key === "after") {
                yield* Deferred.succeed(afterStarted, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("blocker", "first");
        yield* Deferred.await(blockerStarted);
        yield* worker.enqueue("target", "first");

        const flushed = yield* Effect.forkChild(worker.flushKey("target"));
        yield* Deferred.await(firstFlushStarted);
        yield* worker.enqueue("target", "second");
        yield* worker.enqueue("after", "only");

        yield* Deferred.succeed(releaseBlocker, undefined);
        yield* Deferred.await(afterStarted);

        expect(yield* Deferred.isDone(secondFlushStarted)).toBe(false);

        yield* Deferred.succeed(releaseFirstFlush, undefined);
        yield* Fiber.join(flushed);
        expect(yield* Deferred.isDone(secondFlushStarted)).toBe(true);
      }),
    ),
  );

  it.live("requeues normal follow-up work behind other queued keys", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);
              if (key === "hot" && value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
            }),
        });

        yield* worker.enqueue("hot", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("hot", "second");
        yield* worker.enqueue("other", "only");

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drainKey("hot");
        yield* worker.drainKey("other");

        expect(processed).toEqual(["hot:first", "other:only", "hot:second"]);
      }),
    ),
  );

  it.live("preserves interruption when direct flush processing is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const blockerStarted = yield* Deferred.make<void>();
        const releaseBlocker = yield* Deferred.make<void>();
        const flushStarted = yield* Deferred.make<void>();
        const neverReleaseFlush = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key) =>
            Effect.gen(function* () {
              if (key === "blocker") {
                yield* Deferred.succeed(blockerStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseBlocker);
              }

              if (key === "target") {
                yield* Deferred.succeed(flushStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(neverReleaseFlush);
              }
            }),
        });

        yield* worker.enqueue("blocker", "first");
        yield* Deferred.await(blockerStarted);
        yield* worker.enqueue("target", "terminal");

        const flushed = yield* Effect.forkChild(worker.flushKey("target"));
        yield* Deferred.await(flushStarted);
        yield* Fiber.interrupt(flushed);
        const flushExit = yield* Fiber.await(flushed);

        expect(Exit.isFailure(flushExit)).toBe(true);
        if (Exit.isFailure(flushExit)) {
          expect(Cause.hasInterruptsOnly(flushExit.cause)).toBe(true);
        }

        yield* Deferred.succeed(releaseBlocker, undefined);
      }),
    ),
  );

  it.live("stops active processing when its owning scope closes", () =>
    Effect.gen(function* () {
      const workerScope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const neverRelease = yield* Deferred.make<void>();

      const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
        merge: (_current, next) => next,
        process: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined).pipe(Effect.orDie);
            yield* Deferred.await(neverRelease);
          }).pipe(
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.orDie)),
          ),
      }).pipe(Effect.provideService(Scope.Scope, workerScope));

      yield* worker.enqueue("child", "progress");
      yield* Deferred.await(started);
      yield* Scope.close(workerScope, Exit.void);

      expect(yield* Deferred.isDone(interrupted)).toBe(true);
    }),
  );
});
