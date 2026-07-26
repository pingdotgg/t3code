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
const provider = ProviderDriverKind.make("claudex");

const event = (
  type:
    | "session.started"
    | "session.exited"
    | "turn.started"
    | "content.delta"
    | "account.rate-limits.updated"
    | "compaction.started"
    | "compaction.completed",
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
    case "compaction.started":
      return {
        ...base,
        type: "item.started",
        turnId,
        payload: { itemType: "context_compaction" as const, status: "inProgress" as const },
      };
    case "compaction.completed":
      return {
        ...base,
        type: "item.completed",
        turnId,
        payload: { itemType: "context_compaction" as const, status: "completed" as const },
      };
  }
};

const withTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestClock.layer()), Effect.scoped);

describe("TurnActivityWatchdog", () => {
  it("uses a 15-minute default and reads the server env override", () => {
    assert.equal(DEFAULT_TURN_STALL_THRESHOLD_MS, 15 * 60 * 1000);
    assert.equal(readTurnStallThresholdMs({ T3CODE_TURN_STALL_THRESHOLD_MS: "45000" }), 45_000);
    for (const malformed of ["invalid", "120000ms", "1.5", "-1", "Infinity"]) {
      assert.equal(
        readTurnStallThresholdMs({ T3CODE_TURN_STALL_THRESHOLD_MS: malformed }),
        15 * 60 * 1000,
      );
    }
  });

  it.effect("applies the 15-minute default threshold to non-ACP providers", () =>
    withTestClock(
      Effect.gen(function* () {
        const transitions = yield* Ref.make<Array<TurnHealthTransition>>([]);
        // No threshold override: the watchdog reads the global default, which
        // intentionally applies to chatty non-ACP providers (claudeAgent
        // here) the same as ACP ones.
        const watchdog = yield* makeTurnActivityWatchdog({
          onTransition: (transition) =>
            Ref.update(transitions, (current) => [...current, transition]),
        });

        yield* watchdog.observe(event("turn.started"));
        yield* TestClock.adjust(Duration.minutes(14));
        assert.deepEqual(yield* Ref.get(transitions), []);

        yield* TestClock.adjust(Duration.minutes(2));
        assert.deepEqual(
          (yield* Ref.get(transitions)).map((transition) => transition.state),
          ["stalled"],
        );
      }),
    ),
  );

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

  it.effect("noteActivity keeps a blocked turn out of stalled and recovers it", () =>
    withTestClock(
      Effect.gen(function* () {
        const transitions = yield* Ref.make<Array<TurnHealthTransition>>([]);
        const watchdog = yield* makeTurnActivityWatchdog({
          thresholdMs: 1_000,
          pollIntervalMs: 100,
          onTransition: (transition) =>
            Ref.update(transitions, (current) => [...current, transition]),
        });

        // A turn blocked on a delegated child emits no runtime events of its
        // own, but the coordinator heartbeats noteActivity — it must never be
        // flagged stalled while the heartbeats keep coming.
        yield* watchdog.observe(event("turn.started"));
        for (let index = 0; index < 12; index += 1) {
          yield* TestClock.adjust(Duration.millis(500));
          yield* watchdog.noteActivity(threadId);
        }
        assert.deepEqual(yield* Ref.get(transitions), []);

        // Once the heartbeats stop the turn stalls, and the next heartbeat
        // recovers it with an active transition.
        yield* TestClock.adjust(Duration.millis(1_200));
        assert.deepEqual(
          (yield* Ref.get(transitions)).map((transition) => transition.state),
          ["stalled"],
        );
        yield* watchdog.noteActivity(threadId);
        assert.deepEqual(
          (yield* Ref.get(transitions)).map((transition) => transition.state),
          ["stalled", "active"],
        );
      }),
    ),
  );

  it.effect("noteActivity is a no-op for untracked threads", () =>
    withTestClock(
      Effect.gen(function* () {
        const transitions = yield* Ref.make<Array<TurnHealthTransition>>([]);
        const watchdog = yield* makeTurnActivityWatchdog({
          thresholdMs: 1_000,
          pollIntervalMs: 100,
          onTransition: (transition) =>
            Ref.update(transitions, (current) => [...current, transition]),
        });

        yield* watchdog.noteActivity(threadId);
        assert.isUndefined(yield* watchdog.getSnapshot(threadId));
        yield* TestClock.adjust(Duration.minutes(10));
        assert.deepEqual(yield* Ref.get(transitions), []);
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

  it.effect("suppresses the stalled verdict while a compaction is active", () =>
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
        yield* watchdog.observe(event("compaction.started"));
        // A long compaction emits no events; it must not be flagged stalled.
        yield* TestClock.adjust(Duration.minutes(10));
        assert.deepEqual(yield* Ref.get(transitions), []);

        // Once the compaction completes, normal stall semantics resume.
        yield* watchdog.observe(event("compaction.completed"));
        yield* TestClock.adjust(Duration.millis(1_200));
        assert.deepEqual(
          (yield* Ref.get(transitions)).map((transition) => transition.state),
          ["stalled"],
        );
      }),
    ),
  );

  it.effect("resumes stall detection when the turn ends mid-compaction", () =>
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
        yield* watchdog.observe(event("compaction.started"));
        yield* watchdog.observe({
          eventId: EventId.make("event-turn-completed"),
          provider,
          threadId,
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "turn.completed",
          turnId,
          payload: { state: "failed" as const },
        });
        yield* TestClock.adjust(Duration.minutes(10));
        // No active turn remains, so nothing can stall.
        assert.deepEqual(yield* Ref.get(transitions), []);

        // A subsequent turn stalls normally; the cleared compaction state must
        // not leak into it.
        yield* watchdog.observe(event("turn.started"));
        yield* TestClock.adjust(Duration.millis(1_200));
        assert.deepEqual(
          (yield* Ref.get(transitions)).map((transition) => transition.state),
          ["stalled"],
        );
      }),
    ),
  );
});
