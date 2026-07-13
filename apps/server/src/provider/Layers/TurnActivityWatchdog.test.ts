import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import { makeTurnActivityWatchdog, type TurnHealthTransition } from "./TurnActivityWatchdog.ts";
import {
  DEFAULT_TURN_STALL_THRESHOLD_MS,
  readTurnStallThresholdMs,
} from "../turnReliabilityConfig.ts";

const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");
const provider = ProviderDriverKind.make("claudeAgent");

const event = (
  type:
    | "session.started"
    | "session.exited"
    | "turn.started"
    | "content.delta"
    | "account.rate-limits.updated",
): ProviderRuntimeEvent => {
  const base = {
    eventId: EventId.make(`event-${type}`),
    provider,
    threadId,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as const;
  switch (type) {
    case "session.started":
      return { ...base, type, payload: {} };
    case "session.exited":
      return { ...base, type, turnId, payload: {} };
    case "turn.started":
      return { ...base, type, turnId, payload: {} };
    case "content.delta":
      return {
        ...base,
        type,
        turnId,
        payload: { delta: "working", streamKind: "assistant_text" as const },
      };
    case "account.rate-limits.updated":
      return { ...base, type, payload: { rateLimits: { remaining: 100 } } };
  }
};

const withTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestClock.layer()), Effect.scoped);

describe("TurnActivityWatchdog", () => {
  it("uses a 120s default and reads the server env override", () => {
    assert.equal(DEFAULT_TURN_STALL_THRESHOLD_MS, 120_000);
    assert.equal(readTurnStallThresholdMs({ T3CODE_TURN_STALL_THRESHOLD_MS: "45000" }), 45_000);
    for (const malformed of ["invalid", "120000ms", "1.5", "-1", "Infinity"]) {
      assert.equal(
        readTurnStallThresholdMs({ T3CODE_TURN_STALL_THRESHOLD_MS: malformed }),
        120_000,
      );
    }
  });

  it.effect("emits one stalled transition and one recovery after activity resumes", () =>
    withTestClock(
      Effect.gen(function* () {
        const transitions = yield* Ref.make<Array<TurnHealthTransition>>([]);
        const watchdog = yield* makeTurnActivityWatchdog({
          thresholdMs: 1_000,
          pollIntervalMs: 100,
          onTransition: (transition) =>
            Ref.update(transitions, (current) => [...current, transition]),
        });

        yield* watchdog.observe(event("turn.started"));
        yield* TestClock.adjust(Duration.millis(1_200));
        assert.deepEqual(
          (yield* Ref.get(transitions)).map((transition) => transition.state),
          ["stalled"],
        );

        yield* TestClock.adjust(Duration.seconds(5));
        assert.equal((yield* Ref.get(transitions)).length, 1);

        yield* watchdog.observe(event("content.delta"));
        assert.deepEqual(
          (yield* Ref.get(transitions)).map((transition) => transition.state),
          ["stalled", "active"],
        );

        yield* watchdog.observe(event("content.delta"));
        assert.equal((yield* Ref.get(transitions)).length, 2);
      }),
    ),
  );

  it.effect("does not stall sessions without an active turn", () =>
    withTestClock(
      Effect.gen(function* () {
        const transitions = yield* Ref.make<Array<TurnHealthTransition>>([]);
        const watchdog = yield* makeTurnActivityWatchdog({
          thresholdMs: 1_000,
          pollIntervalMs: 100,
          onTransition: (transition) =>
            Ref.update(transitions, (current) => [...current, transition]),
        });

        yield* watchdog.observe(event("session.started"));
        yield* TestClock.adjust(Duration.minutes(10));
        assert.deepEqual(yield* Ref.get(transitions), []);
      }),
    ),
  );

  it.effect("ignores chatter while a turn is stalled", () =>
    withTestClock(
      Effect.gen(function* () {
        const transitions = yield* Ref.make<Array<TurnHealthTransition>>([]);
        const watchdog = yield* makeTurnActivityWatchdog({
          thresholdMs: 1_000,
          pollIntervalMs: 100,
          onTransition: (transition) =>
            Ref.update(transitions, (current) => [...current, transition]),
        });

        yield* watchdog.observe(event("turn.started"));
        yield* TestClock.adjust(Duration.millis(1_200));
        const stalledSnapshot = yield* watchdog.getSnapshot(threadId);
        yield* watchdog.observe(event("account.rate-limits.updated"));

        assert.deepEqual(
          (yield* Ref.get(transitions)).map((transition) => transition.state),
          ["stalled"],
        );
        assert.deepEqual(yield* watchdog.getSnapshot(threadId), stalledSnapshot);
      }),
    ),
  );

  it.effect("removes stopped sessions without emitting recovery", () =>
    withTestClock(
      Effect.gen(function* () {
        const transitions = yield* Ref.make<Array<TurnHealthTransition>>([]);
        const watchdog = yield* makeTurnActivityWatchdog({
          thresholdMs: 1_000,
          pollIntervalMs: 100,
          onTransition: (transition) =>
            Ref.update(transitions, (current) => [...current, transition]),
        });

        yield* watchdog.observe(event("turn.started"));
        yield* TestClock.adjust(Duration.millis(1_200));
        yield* watchdog.observe(event("session.exited"));

        assert.deepEqual(
          (yield* Ref.get(transitions)).map((transition) => transition.state),
          ["stalled"],
        );
        assert.isUndefined(yield* watchdog.getSnapshot(threadId));
        yield* TestClock.adjust(Duration.minutes(10));
        assert.equal((yield* Ref.get(transitions)).length, 1);
      }),
    ),
  );
});
