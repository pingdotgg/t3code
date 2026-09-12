import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  relayHttpResponseBodyStream,
  relayHttpResponseIdleWatchdog,
  type RelayHttpResponseBodyEvent,
} from "./httpResponseBody.ts";

describe("relay HTTP response body", () => {
  it.effect("ends normally only for an explicit end event", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RelayHttpResponseBodyEvent>();
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(1, 2, 3) });
      yield* Queue.offer(queue, { type: "end" });

      const chunks = yield* Stream.runCollect(relayHttpResponseBodyStream(queue));
      expect([...chunks].map((chunk) => [...chunk])).toEqual([[1, 2, 3]]);
    }),
  );

  it.effect("fails rather than returning a truncated success body after an abort", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RelayHttpResponseBodyEvent>();
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(1, 2, 3) });
      yield* Queue.offer(queue, { type: "abort", reason: "connector disconnected" });

      const exit = yield* Effect.exit(Stream.runCollect(relayHttpResponseBodyStream(queue)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toMatch(/connector disconnected/u);
      }
    }),
  );

  it.effect("the idle watchdog fires only when chunk progress stops", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RelayHttpResponseBodyEvent>();
      const progress = { lastChunkAt: yield* Clock.currentTimeMillis };
      const stream = relayHttpResponseBodyStream(queue, progress);
      // Consume one chunk at a time so we control when progress advances.
      const collected: Array<number> = [];
      const consumer = yield* Stream.runForEach(stream, (chunk) =>
        Effect.sync(() => {
          collected.push(...chunk);
        }),
      ).pipe(Effect.exit, Effect.forkChild);
      const watchdog = yield* relayHttpResponseIdleWatchdog(progress, "10 seconds").pipe(
        Effect.andThen(Queue.shutdown(queue)),
        Effect.forkChild,
      );

      // A slow reader that keeps making progress never trips it.
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(1) });
      yield* TestClock.adjust("8 seconds");
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(2) });
      yield* TestClock.adjust("8 seconds");
      expect(collected).toEqual([1, 2]);
      expect(watchdog.pollUnsafe()).toBeUndefined();

      // A stalled one does, and shutting the queue ends the consumer.
      yield* TestClock.adjust("11 seconds");
      yield* Fiber.join(watchdog);
      const exit = yield* Fiber.join(consumer);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
