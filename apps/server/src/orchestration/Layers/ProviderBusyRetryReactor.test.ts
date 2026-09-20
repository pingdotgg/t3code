import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  isProviderBusyError,
  makeProviderBusyRetryHandler,
  PROVIDER_BUSY_RETRY_TEXT,
} from "./ProviderBusyRetryReactor.ts";

const threadId = ThreadId.make("thread-provider-busy");
const busyError = "Selected model is at capacity. Please try a different model.";

const makeThread = (
  turn: string,
  latestUserMessageAt: string | null,
  overrides: Record<string, unknown> = {},
) =>
  ({
    id: threadId,
    archivedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    modelSelection: { instanceId: "codex", model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    latestTurn: { turnId: TurnId.make(turn), state: "error" },
    latestUserMessageAt,
    session: { status: "error", lastError: busyError },
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const sessionSet = (lastError: string, status = "error") =>
  ({
    type: "thread.session-set",
    payload: { threadId, session: { status, lastError } },
  }) as unknown as Extract<OrchestrationEvent, { type: "thread.session-set" }>;

const setup = Effect.gen(function* () {
  const state = { thread: makeThread("turn-1", "2026-01-01T00:00:00.000Z") };
  const starts: Array<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = [];
  const control = { rejectDispatch: false, ids: 0 };
  const handle = makeProviderBusyRetryHandler({
    scope: yield* Effect.scope,
    readThread: () => Effect.succeed(state.thread),
    makeId: Effect.sync(() => `id-${++control.ids}`),
    dispatch: (command) =>
      control.rejectDispatch
        ? Effect.fail(new Error("rejected") as never)
        : Effect.sync(() => {
            if (command.type === "thread.turn.start") starts.push(command);
            return { sequence: starts.length };
          }),
  });
  return { state, starts, handle, control };
});

it("matches overload errors but not revoked-credential 503s", () => {
  assert.isTrue(isProviderBusyError(busyError));
  assert.isTrue(isProviderBusyError("The server is currently overloaded."));
  assert.isTrue(isProviderBusyError("api error: overloaded_error"));
  assert.isFalse(
    isProviderBusyError(
      "unexpected status 503 Service Unavailable: auth_unavailable: no auth available",
    ),
  );
  assert.isFalse(isProviderBusyError("You've hit your usage limit."));
  assert.isFalse(isProviderBusyError("Disk at capacity while writing."));
});

it.effect("continues the turn once after the delay, ignoring duplicate failure reports", () =>
  Effect.gen(function* () {
    const { starts, handle } = yield* setup;
    yield* handle(sessionSet(busyError));
    yield* handle(sessionSet(busyError));
    yield* handle(sessionSet("Turn failed"));
    yield* handle(sessionSet(busyError, "ready"));
    yield* TestClock.adjust(Duration.seconds(59));
    assert.lengthOf(starts, 0);
    yield* TestClock.adjust(Duration.seconds(1));
    assert.lengthOf(starts, 1);
    assert.equal(starts[0]!.message.text, PROVIDER_BUSY_RETRY_TEXT);
    assert.equal(starts[0]!.runtimeMode, "full-access");
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("yields to a user message sent while the retry waits", () =>
  Effect.gen(function* () {
    const { state, starts, handle } = yield* setup;
    yield* handle(sessionSet(busyError));
    state.thread = makeThread("turn-1", "2026-01-01T00:00:30.000Z");
    yield* TestClock.adjust(Duration.minutes(1));
    assert.lengthOf(starts, 0);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("backs off across consecutive busy failures and stops when the budget is spent", () =>
  Effect.gen(function* () {
    const { state, starts, handle } = yield* setup;
    const delays = [Duration.minutes(1), Duration.minutes(5), Duration.minutes(15)];
    for (const [index, delay] of delays.entries()) {
      yield* handle(sessionSet(busyError));
      yield* TestClock.adjust(delay);
      assert.lengthOf(starts, index + 1);
      // The retry turn itself fails busy: its message is now the latest user message.
      state.thread = makeThread(`turn-${index + 2}`, starts[index]!.createdAt);
    }
    // Spent stays spent: repeated busy reports cannot start a new cycle.
    for (let report = 0; report < 3; report++) {
      yield* handle(sessionSet(busyError));
      yield* TestClock.adjust(Duration.hours(1));
    }
    assert.lengthOf(starts, 3);
    // Only a real user message buys a new budget.
    state.thread = makeThread("turn-user", "2026-01-02T00:00:00.000Z");
    yield* handle(sessionSet(busyError));
    yield* TestClock.adjust(Duration.minutes(1));
    assert.lengthOf(starts, 4);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("reschedules for a newer failure instead of dropping it", () =>
  Effect.gen(function* () {
    const { state, starts, handle } = yield* setup;
    yield* handle(sessionSet(busyError));
    yield* TestClock.adjust(Duration.seconds(30));
    // The user resends and that turn fails busy too, while the first retry waits.
    state.thread = makeThread("turn-2", "2026-01-01T00:00:30.000Z");
    yield* handle(sessionSet(busyError));
    yield* TestClock.adjust(Duration.seconds(30));
    assert.lengthOf(starts, 0);
    yield* TestClock.adjust(Duration.seconds(30));
    assert.lengthOf(starts, 1);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect.each([
  ["a later non-busy error", { session: { status: "error", lastError: "Turn failed" } }],
  ["a recovered session", { session: { status: "ready", lastError: null } }],
  ["a snoozed thread", { snoozedUntil: "2026-01-03T00:00:00.000Z" }],
  ["a settled thread", { settledOverride: "settled" }],
  ["an archived thread", { archivedAt: "2026-01-01T00:00:10.000Z" }],
] as const)("does not deliver into %s", ([, overrides]) =>
  Effect.gen(function* () {
    const { state, starts, handle } = yield* setup;
    yield* handle(sessionSet(busyError));
    state.thread = makeThread("turn-1", "2026-01-01T00:00:00.000Z", overrides);
    yield* TestClock.adjust(Duration.minutes(1));
    assert.lengthOf(starts, 0);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("delivers once a snooze has expired", () =>
  Effect.gen(function* () {
    const { state, starts, handle } = yield* setup;
    yield* handle(sessionSet(busyError));
    // The test clock starts at the epoch, so any 1969 time is in the past.
    state.thread = makeThread("turn-1", "2026-01-01T00:00:00.000Z", {
      snoozedUntil: "1969-12-31T00:00:00.000Z",
    });
    yield* TestClock.adjust(Duration.minutes(1));
    assert.lengthOf(starts, 1);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("ignores a busy-looking error after a turn that completed", () =>
  Effect.gen(function* () {
    const { state, starts, handle } = yield* setup;
    state.thread = makeThread("turn-1", "2026-01-01T00:00:00.000Z", {
      latestTurn: { turnId: TurnId.make("turn-1"), state: "completed" },
    });
    yield* handle(sessionSet(busyError));
    yield* TestClock.adjust(Duration.hours(1));
    assert.lengthOf(starts, 0);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("spends the attempt when the dispatch is rejected", () =>
  Effect.gen(function* () {
    const { starts, handle, control } = yield* setup;
    control.rejectDispatch = true;
    for (const delay of [Duration.minutes(1), Duration.minutes(5), Duration.minutes(15)]) {
      yield* handle(sessionSet(busyError));
      yield* TestClock.adjust(delay);
    }
    control.rejectDispatch = false;
    yield* handle(sessionSet(busyError));
    yield* TestClock.adjust(Duration.hours(1));
    assert.lengthOf(starts, 0);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);
