import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedCoalescingWorker } from "./KeyedCoalescingWorker.ts";

describe("makeKeyedCoalescingWorker", () => {
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

  it.live("lets other keys progress while one key stays continuously dirty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const busyStarted = yield* Deferred.make<void>();
        const releaseBusy = yield* Deferred.make<void>();
        const quietProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "busy-1") {
                yield* Deferred.succeed(busyStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseBusy);
              }

              if (key === "quiet") {
                yield* Deferred.succeed(quietProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("busy", "busy-1");
        yield* Deferred.await(busyStarted);

        // While the busy key is mid-batch, it becomes dirty again and another
        // key arrives. The dirty key must go to the queue tail, not back into
        // the worker, or the quiet key's flush never runs.
        yield* worker.enqueue("busy", "busy-2");
        yield* worker.enqueue("quiet", "quiet-1");
        yield* Deferred.succeed(releaseBusy, undefined);

        yield* Deferred.await(quietProcessed);
        yield* worker.drainKey("quiet");
        yield* worker.drainKey("busy");

        expect(processed).toEqual(["busy:busy-1", "quiet:quiet-1", "busy:busy-2"]);
      }),
    ),
  );

  it.live("still coalesces updates that land while their key waits at the queue tail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const otherStarted = yield* Deferred.make<void>();
        const releaseOther = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (current, next) => `${current}+${next}`,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }

              if (key === "other") {
                yield* Deferred.succeed(otherStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseOther);
              }
            }),
        });

        yield* worker.enqueue("busy", "first");
        yield* Deferred.await(firstStarted);

        // Dirty the busy key mid-batch so it gets requeued behind "other",
        // then keep writing to it while it waits at the tail. Every write must
        // fold into one merged batch, not extra queue entries.
        yield* worker.enqueue("busy", "a");
        yield* worker.enqueue("other", "other-1");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(otherStarted);
        yield* worker.enqueue("busy", "b");
        yield* worker.enqueue("busy", "c");
        yield* Deferred.succeed(releaseOther, undefined);

        yield* worker.drainKey("busy");
        yield* worker.drainKey("other");

        expect(processed).toEqual(["busy:first", "other:other-1", "busy:a+b+c"]);
      }),
    ),
  );
});
