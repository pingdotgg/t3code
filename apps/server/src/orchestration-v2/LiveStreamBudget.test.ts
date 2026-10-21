import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  bufferLatestLiveStream,
  makeLiveStreamBudget,
  replayAndBufferLiveEvents,
  type RetainedLiveItem,
} from "./LiveStreamBudget.ts";

describe("LiveStreamBudget", () => {
  it.effect("closes the source without releasing a batch still waiting for an ACK", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const budget = yield* makeLiveStreamBudget({ maxItems: 3 });
        const queue = yield* Queue.unbounded<RetainedLiveItem<{ text: string }>>();
        const sourceClosed = yield* Deferred.make<void>();
        const first = yield* budget.retain({ text: "first" });
        const second = yield* budget.retain({ text: "second" });
        const third = yield* budget.retain({ text: "third" });
        yield* Queue.offerAll(queue, [first, second, third]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(
              budget.deliver(
                Stream.fromQueue(queue).pipe(
                  Stream.rechunk(1),
                  Stream.ensuring(Deferred.succeed(sourceClosed, undefined)),
                ),
              ),
            );
            expect(yield* pull).toEqual([{ text: "first" }]);
            expect(yield* Queue.size(queue)).toBe(0);
            expect((yield* budget.usage).retainedItems).toBe(3);
            const overflow = yield* budget.retain({ text: "fourth" }).pipe(Effect.result);
            expect(overflow._tag).toBe("Failure");
            yield* Deferred.await(sourceClosed);
            yield* budget.closed;
            expect((yield* budget.usage).retainedItems).toBe(1);
          }),
        );
        expect(yield* budget.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );
});

type Event = { readonly sequence: number; readonly text: string; readonly threadId?: string };

describe("bufferLatestLiveStream", () => {
  it.effect.each(["items", "bytes"] as const)(
    "counts an unacknowledged state against the %s limit when its replacement arrives",
    (limit) =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseUpdate = yield* Deferred.make<void>();
          const closed = yield* Deferred.make<void>();
          const first = { sequence: 1, text: "é".repeat(20) };
          const next = { ...first, sequence: 2 };
          const pull = yield* Stream.toPull(
            bufferLatestLiveStream(
              Stream.concat(
                Stream.succeed(first),
                Stream.fromEffect(Deferred.await(releaseUpdate)).pipe(Stream.map(() => next)),
              ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined))),
              () => "same-thread",
              limit === "items"
                ? { maxItems: 1 }
                : { maxSerializedBytes: Buffer.byteLength(JSON.stringify(first)) },
            ),
          );
          expect(yield* pull).toEqual([first]);
          yield* Deferred.succeed(releaseUpdate, undefined);
          yield* Deferred.await(closed);
          const result = yield* pull.pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("LiveStreamBufferError");
        }),
      ),
  );
});

describe("replayAndBufferLiveEvents", () => {
  it.effect.each(["high-water", "replay"] as const)(
    "unsubscribes and cancels a blocked %s read on live overflow",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<Event>();
          const subscribed = yield* Deferred.make<PubSub.Subscription<Event>>();
          const readStarted = yield* Deferred.make<void>();
          const readClosed = yield* Deferred.make<void>();
          const blockedRead = Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(readClosed, undefined)),
          );
          const pull = yield* Stream.toPull(
            replayAndBufferLiveEvents(
              {
                subscribe: PubSub.subscribe(pubsub).pipe(
                  Effect.tap((subscription) => Deferred.succeed(subscribed, subscription)),
                ),
                latestSequence:
                  phase === "high-water" ? blockedRead.pipe(Effect.as(0)) : Effect.succeed(0),
                replay: () => (phase === "replay" ? Stream.fromEffect(blockedRead) : Stream.empty),
              },
              { maxItems: 2 },
            ),
          );
          const reader = yield* pull.pipe(Effect.result, Effect.forkScoped);
          yield* Deferred.await(readStarted);
          yield* PubSub.publishAll(pubsub, [
            { sequence: 1, text: "one" },
            { sequence: 2, text: "two" },
            { sequence: 3, text: "overflow" },
          ]);
          yield* (yield* Deferred.await(subscribed)).shutdownHook.await;
          yield* Deferred.await(readClosed);
          const result = yield* Fiber.join(reader);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("LiveStreamBufferError");
          expect(yield* PubSub.size(pubsub)).toBe(0);
          yield* PubSub.publish(pubsub, { sequence: 4, text: "after overflow" });
          expect(yield* PubSub.size(pubsub)).toBe(0);
        }),
      ),
  );

  it.effect("lets a fast reader replay a database page larger than both buffer limits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<Event>();
        const events = Array.from({ length: 20 }, (_, index) => ({
          sequence: index + 1,
          text: "historical event",
        }));
        const replayed = yield* replayAndBufferLiveEvents(
          {
            subscribe: PubSub.subscribe(pubsub),
            latestSequence: Effect.succeed(20),
            replay: () => Stream.fromIterable(events),
          },
          { maxItems: 2, maxSerializedBytes: 100 },
        ).pipe(Stream.take(20), Stream.runCollect);
        expect(replayed).toEqual(events);
        expect(yield* PubSub.size(pubsub)).toBe(0);
      }),
    ),
  );

  it.effect(
    "filters unrelated events before buffering and deduplicates the replay/live overlap",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<Event>();
          const highWaterStarted = yield* Deferred.make<void>();
          const highWater = yield* Deferred.make<number>();
          const first = { sequence: 1, text: "first", threadId: "selected" };
          const overlap = { sequence: 2, text: "overlap", threadId: "selected" };
          const last = { sequence: 10, text: "last", threadId: "selected" };
          const reader = yield* replayAndBufferLiveEvents(
            {
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: Deferred.succeed(highWaterStarted, undefined).pipe(
                Effect.andThen(Deferred.await(highWater)),
              ),
              replay: () => Stream.make(first, overlap),
              filter: (event) => event.threadId === "selected",
            },
            { maxItems: 4 },
          ).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped);
          yield* Deferred.await(highWaterStarted);
          yield* PubSub.publishAll(pubsub, [
            overlap,
            ...Array.from({ length: 6 }, (_, index) => ({
              sequence: index + 3,
              text: "unrelated",
              threadId: "other",
            })),
            last,
          ]);
          yield* Deferred.succeed(highWater, 2);
          expect(yield* Fiber.join(reader)).toEqual([first, overlap, last]);
          expect(yield* PubSub.size(pubsub)).toBe(0);
        }),
      ),
  );
});
