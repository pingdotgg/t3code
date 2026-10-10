import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedCoalescingWorker } from "./KeyedCoalescingWorker.ts";

describe("makeKeyedCoalescingWorker", () => {
  it.live("lets a queued key drain before a continuously updated key finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const busyStarted = yield* Deferred.make<void>();
        const releaseBusy = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, number, never, never>({
          merge: (_current, next) => next,
          process: (key, value): Effect.Effect<void> =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);
              if (key !== "busy") return;

              if (value === 1) {
                yield* Deferred.succeed(busyStarted, undefined);
                yield* Deferred.await(releaseBusy);
              }
              if (value < 4) yield* worker.enqueue(key, value + 1);
            }),
        });

        yield* worker.enqueue("busy", 1);
        yield* Deferred.await(busyStarted);
        yield* worker.enqueue("quiet", 1);
        yield* Deferred.succeed(releaseBusy, undefined);
        yield* worker.drainKey("quiet");
        yield* worker.drainKey("busy");

        expect(processed).toEqual(["busy:1", "quiet:1", "busy:2", "busy:3", "busy:4"]);
      }),
    ),
  );

  it.live("merges updates while waiting behind another key and drains the merged batch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const busyStarted = yield* Deferred.make<void>();
        const releaseBusy = yield* Deferred.make<void>();
        const quietStarted = yield* Deferred.make<void>();
        const releaseQuiet = yield* Deferred.make<void>();
        const mergedStarted = yield* Deferred.make<void>();
        const releaseMerged = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (current, next) => `${current}+${next}`,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);
              if (value === "first") {
                yield* Deferred.succeed(busyStarted, undefined);
                yield* Deferred.await(releaseBusy);
              } else if (key === "quiet") {
                yield* Deferred.succeed(quietStarted, undefined);
                yield* Deferred.await(releaseQuiet);
              } else if (value === "a+b+c") {
                yield* Deferred.succeed(mergedStarted, undefined);
                yield* Deferred.await(releaseMerged);
              }
            }),
        });

        yield* worker.enqueue("busy", "first");
        yield* Deferred.await(busyStarted);
        yield* worker.enqueue("quiet", "quiet");
        yield* worker.enqueue("busy", "a");
        yield* Deferred.succeed(releaseBusy, undefined);
        yield* Deferred.await(quietStarted);
        expect(processed).toEqual(["busy:first", "quiet:quiet"]);
        yield* worker.enqueue("busy", "b");
        yield* worker.enqueue("busy", "c");

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drainKey("busy").pipe(Effect.andThen(Deferred.succeed(drained, undefined))),
          { startImmediately: true },
        );
        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseQuiet, undefined);
        yield* Deferred.await(mergedStarted);
        expect(yield* Deferred.isDone(drained)).toBe(false);
        yield* Deferred.succeed(releaseMerged, undefined);
        yield* Deferred.await(drained);
        yield* worker.drainKey("quiet");

        expect(processed).toEqual(["busy:first", "quiet:quiet", "busy:a+b+c"]);
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
        yield* worker.enqueue("terminal-2", "quiet");
        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* Deferred.await(secondProcessed);
        yield* worker.drainKey("terminal-1");

        expect(processed).toEqual(["terminal-1:first", "terminal-2:quiet", "terminal-1:second"]);
      }),
    ),
  );
});
