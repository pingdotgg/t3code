import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  isProviderBusyError,
  makeRetryHandler,
  PROVIDER_BUSY_RETRY_TEXT,
} from "./ProviderBusyRetryReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

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
    session: { status: "error", activeTurnId: null, lastError: busyError },
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const sessionSet = (lastError: string, status = "error") =>
  ({
    type: "thread.session-set",
    sequence: 10,
    payload: { threadId, session: { status, lastError } },
  }) as unknown as Extract<OrchestrationEvent, { type: "thread.session-set" }>;

const setup = Effect.gen(function* () {
  const state = { thread: makeThread("turn-1", "2026-01-01T00:00:00.000Z") };
  const starts: Array<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = [];
  const control = { rejectDispatch: false, ids: 0 };
  const handle = yield* makeRetryHandler.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeed(Option.fromNullishOr(state.thread)),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            control.rejectDispatch
              ? Effect.fail(new Error("rejected") as never)
              : Effect.sync(() => {
                  if (command.type === "thread.turn.start") starts.push(command);
                  return { sequence: starts.length };
                }),
        }),
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size).fill(++control.ids),
            digest: () => Effect.die("unused"),
          }),
        ),
      ),
    ),
  );
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
    // Naming a model would override one the user picks while the retry is in flight.
    assert.isUndefined(starts[0]!.modelSelection);
    // The engine re-checks the observed state, so a user message that lands first wins.
    assert.deepEqual(starts[0]!.onlyIfUnchanged, {
      snapshotSequence: 10,
      latestTurnId: TurnId.make("turn-1"),
      latestUserMessageAt: "2026-01-01T00:00:00.000Z",
      busyError,
    });
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

it.effect("bounds retries even when the user's timestamp is ahead of the server clock", () =>
  Effect.gen(function* () {
    const { state, starts, handle } = yield* setup;
    const delays = [Duration.minutes(1), Duration.minutes(5), Duration.minutes(15)];
    for (const [index, delay] of delays.entries()) {
      yield* handle(sessionSet(busyError));
      yield* TestClock.adjust(delay);
      assert.lengthOf(starts, index + 1);
      yield* handle({
        type: "thread.message-sent",
        sequence: 11 + index,
        commandId: starts[index]!.commandId,
        payload: {
          threadId,
          messageId: starts[index]!.message.messageId,
          role: "user",
          createdAt: starts[index]!.createdAt,
        },
      } as Extract<OrchestrationEvent, { type: "thread.message-sent" }>);
      // Mirror the projection's monotonic maximum. The fixture's user timestamp
      // is ahead of TestClock, so our server-authored message does not advance it.
      const latestUserMessageAt = state.thread.latestUserMessageAt;
      state.thread = makeThread(
        `turn-${index + 2}`,
        latestUserMessageAt !== null && latestUserMessageAt > starts[index]!.createdAt
          ? latestUserMessageAt
          : starts[index]!.createdAt,
      );
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

it.effect.each([
  { type: "thread.turn-interrupt-requested", alreadyPending: false },
  { type: "thread.session-stop-requested", alreadyPending: false },
  { type: "thread.turn-interrupt-requested", alreadyPending: true },
  { type: "thread.session-stop-requested", alreadyPending: true },
] as const)(
  "preserves $type cancellation before a late failure (pending=$alreadyPending)",
  ({ type, alreadyPending }) =>
    Effect.gen(function* () {
      const { state, starts, handle } = yield* setup;
      if (alreadyPending) yield* handle(sessionSet(busyError));
      yield* handle({
        type,
        payload: { threadId, createdAt: "2026-01-01T00:00:10.000Z" },
      } as Extract<OrchestrationEvent, { type: typeof type }>);
      yield* handle(sessionSet(busyError));
      yield* TestClock.adjust(Duration.hours(1));
      assert.lengthOf(starts, 0);
      state.thread = makeThread("turn-user", "2026-01-02T00:00:00.000Z");
      yield* handle(sessionSet(busyError));
      yield* TestClock.adjust(Duration.minutes(1));
      assert.lengthOf(starts, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("does not retry while the provider still has an active turn", () =>
  Effect.gen(function* () {
    const { state, starts, handle } = yield* setup;
    state.thread = makeThread("turn-1", "2026-01-01T00:00:00.000Z", {
      session: { status: "error", lastError: busyError, activeTurnId: TurnId.make("turn-1") },
    });
    yield* handle(sessionSet(busyError));
    yield* TestClock.adjust(Duration.minutes(1));
    assert.lengthOf(starts, 0);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect("cancels on archive even if the thread is unarchived before the delay expires", () =>
  Effect.gen(function* () {
    const { starts, handle } = yield* setup;
    yield* handle(sessionSet(busyError));
    yield* handle({
      type: "thread.archived",
      payload: { threadId, archivedAt: "2026-01-01T00:00:10.000Z" },
    } as Extract<OrchestrationEvent, { type: "thread.archived" }>);
    // The snapshot is already unarchived again; observing the archive still cancels.
    yield* TestClock.adjust(Duration.hours(1));
    assert.lengthOf(starts, 0);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it.effect.each(["2026-01-01T00:00:00.000Z", "2025-12-31T23:59:00.000Z"])(
  "cancels on a real user message timestamped %s even if the projection cursor does not move",
  (createdAt) =>
    Effect.gen(function* () {
      const { state, starts, handle } = yield* setup;
      yield* handle(sessionSet(busyError));
      yield* handle({
        type: "thread.message-sent",
        sequence: 11,
        commandId: CommandId.make("real-user"),
        payload: { threadId, messageId: MessageId.make("real-user"), role: "user", createdAt },
      } as Extract<OrchestrationEvent, { type: "thread.message-sent" }>);
      yield* TestClock.adjust(Duration.hours(1));
      assert.lengthOf(starts, 0);
      // A subsequent failure of that user's new turn gets a fresh retry allowance.
      state.thread = makeThread("new-user-turn", state.thread.latestUserMessageAt);
      yield* handle(sessionSet(busyError));
      yield* TestClock.adjust(Duration.minutes(1));
      assert.lengthOf(starts, 1);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);
