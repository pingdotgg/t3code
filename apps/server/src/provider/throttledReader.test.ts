import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { makeThrottledReader, readDue } from "./throttledReader.ts";

const pacing = { intervalMs: 60_000, maxIntervalMs: 8 * 60_000, keepLastMs: 15 * 60_000 };
const MINUTE = 60_000;

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

// Each request takes the next answer; `refused` stands for a 429.
const answering = (answers: ReadonlyArray<number | "refused">) => {
  let calls = 0;
  const request = Effect.suspend((): Effect.Effect<number, Refused> => {
    const answer = answers[calls++];
    return answer === "refused" ? Effect.fail(new Refused()) : Effect.succeed(answer ?? -1);
  });
  return { request, calls: () => calls };
};

describe("readDue", () => {
  it("is due when never asked or when the last request is an interval old", () => {
    expect(readDue(pacing, null, 1_000)).toBe(true);
    expect(readDue(pacing, 1_000, 1_000 + MINUTE - 1)).toBe(false);
    expect(readDue(pacing, 1_000, 1_000 + MINUTE)).toBe(true);
  });

  it("doubles the wait for each failed request in a row, up to the maximum", () => {
    expect(readDue(pacing, 0, 2 * MINUTE - 1, 1)).toBe(false);
    expect(readDue(pacing, 0, 2 * MINUTE, 1)).toBe(true);
    expect(readDue(pacing, 0, 4 * MINUTE - 1, 2)).toBe(false);
    expect(readDue(pacing, 0, 8 * MINUTE - 1, 10)).toBe(false);
    expect(readDue(pacing, 0, 8 * MINUTE, 10)).toBe(true);
  });
});

describe("makeThrottledReader", () => {
  it.effect("asks each key at most once per interval", () =>
    Effect.gen(function* () {
      const reader = yield* makeThrottledReader<number, Refused>(pacing);
      const first = answering([10, 20]);
      const second = answering([30]);
      expect(yield* reader.read("first", first.request)).toBe(10);
      expect(yield* reader.read("first", first.request)).toBe(10);
      // Keys are paced on their own.
      expect(yield* reader.read("second", second.request)).toBe(30);
      yield* TestClock.adjust(MINUTE - 1);
      expect(yield* reader.read("first", first.request)).toBe(10);
      expect(first.calls()).toBe(1);
      yield* TestClock.adjust(1);
      expect(yield* reader.read("first", first.request)).toBe(20);
      expect(first.calls()).toBe(2);
    }),
  );

  it.effect("keeps the last answer through refusals and doubles the wait after each", () =>
    Effect.gen(function* () {
      const reader = yield* makeThrottledReader<number, Refused>(pacing);
      const source = answering([10, "refused", "refused", 40]);
      expect(yield* reader.read("claude", source.request)).toBe(10);
      yield* TestClock.adjust(MINUTE);
      expect(yield* reader.read("claude", source.request)).toBe(10);
      expect(source.calls()).toBe(2);
      // Two minutes after the first refusal.
      yield* TestClock.adjust(2 * MINUTE - 1);
      expect(yield* reader.read("claude", source.request)).toBe(10);
      expect(source.calls()).toBe(2);
      yield* TestClock.adjust(1);
      expect(yield* reader.read("claude", source.request)).toBe(10);
      expect(source.calls()).toBe(3);
      // Four minutes after the second.
      yield* TestClock.adjust(4 * MINUTE - 1);
      expect(yield* reader.read("claude", source.request)).toBe(10);
      expect(source.calls()).toBe(3);
      yield* TestClock.adjust(1);
      expect(yield* reader.read("claude", source.request)).toBe(40);
      // An answer resets the wait to one interval.
      yield* TestClock.adjust(MINUTE);
      yield* reader.read("claude", source.request);
      expect(source.calls()).toBe(5);
    }),
  );

  it.effect("fails a refusal with nothing to show again without asking inside the wait", () =>
    Effect.gen(function* () {
      const reader = yield* makeThrottledReader<number, Refused>(pacing);
      const source = answering(["refused", 10]);
      expect(yield* Effect.flip(reader.read("claude", source.request))).toBeInstanceOf(Refused);
      yield* TestClock.adjust(MINUTE);
      expect(yield* Effect.flip(reader.read("claude", source.request))).toBeInstanceOf(Refused);
      expect(source.calls()).toBe(1);
      yield* TestClock.adjust(MINUTE);
      expect(yield* reader.read("claude", source.request)).toBe(10);
    }),
  );

  it.effect("lets the last answer go once it is older than keepLastMs", () =>
    Effect.gen(function* () {
      const reader = yield* makeThrottledReader<number, Refused>(pacing);
      const source = answering([10, "refused", "refused", "refused", "refused"]);
      expect(yield* reader.read("claude", source.request)).toBe(10);
      // Refused at 1, 3 and 7 minutes; the next request is due at 15.
      for (const minutes of [1, 2, 4]) {
        yield* TestClock.adjust(minutes * MINUTE);
        expect(yield* reader.read("claude", source.request)).toBe(10);
      }
      expect(source.calls()).toBe(4);
      yield* TestClock.adjust(8 * MINUTE - 1);
      expect(yield* reader.read("claude", source.request)).toBe(10);
      yield* TestClock.adjust(1);
      expect(yield* Effect.flip(reader.read("claude", source.request))).toBeInstanceOf(Refused);
      expect(source.calls()).toBe(5);
    }),
  );

  it.effect("forget makes the next read ask, and drops the old answer and wait", () =>
    Effect.gen(function* () {
      const reader = yield* makeThrottledReader<number, Refused>(pacing);
      const source = answering([10, "refused", "refused", 0]);
      expect(yield* reader.read("codex", source.request)).toBe(10);
      yield* TestClock.adjust(MINUTE);
      expect(yield* reader.read("codex", source.request)).toBe(10);
      // A redeem changes the answer: the wait and the old answer both go.
      yield* reader.forget("codex");
      expect(yield* Effect.flip(reader.read("codex", source.request))).toBeInstanceOf(Refused);
      expect(source.calls()).toBe(3);
    }),
  );

  it.effect("does not store an answer that was in flight when the key was forgotten", () =>
    Effect.gen(function* () {
      const reader = yield* makeThrottledReader<number, Refused>(pacing);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const slow = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(10),
      );
      const fiber = yield* Effect.forkChild(reader.read("codex", slow));
      yield* Deferred.await(started);
      yield* reader.forget("codex");
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(fiber)).toBe(10);
      const fresh = answering([20]);
      expect(yield* reader.read("codex", fresh.request)).toBe(20);
    }),
  );
});
