import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderCommitBatch from "./ProviderCommitBatch.ts";

function event(id: number, text = "delta"): OrchestrationV2DomainEvent {
  const threadId = ThreadId.make(`thread:${id}`);
  const now = DateTime.makeUnsafe("2026-11-03T00:00:00Z");
  return {
    id: EventId.make(`event:${id}`),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: MessageId.make(`message:${id}`),
      threadId,
      runId: null,
      nodeId: null,
      createdBy: "agent",
      creationSource: "web",
      role: "assistant",
      text,
      attachments: [],
      streaming: true,
      createdAt: now,
      updatedAt: now,
    },
  };
}

it.effect.each([false, true])(
  "acknowledges shared commits through publication with cancellation=%s",
  (cancel) =>
    Effect.gen(function* () {
      const commits: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
      const publishing = yield* Deferred.make<void>();
      const published = yield* Deferred.make<void>();
      const batch = yield* ProviderCommitBatch.make(
        (events) =>
          Effect.gen(function* () {
            commits.push(events);
            yield* Deferred.succeed(publishing, undefined);
            yield* Deferred.await(published);
            return events.map((event, index) => ({ sequence: index + 1, commandId: null, event }));
          }),
        25,
      );
      const first = yield* batch
        .write([event(1)])
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const second = yield* batch
        .write([event(2)])
        .pipe(Effect.forkScoped({ startImmediately: true }));
      assert.deepEqual(commits, []);
      yield* TestClock.adjust(25);
      yield* Deferred.await(publishing);
      assert.isUndefined(yield* Effect.sync(() => first.pollUnsafe()));
      const interrupted = cancel
        ? yield* Fiber.interrupt(second).pipe(Effect.forkScoped({ startImmediately: true }))
        : undefined;
      yield* Deferred.succeed(published, undefined);
      assert.deepEqual(
        (yield* Fiber.join(first)).map((stored) => stored.event.id),
        ["event:1"],
      );
      if (interrupted !== undefined) {
        yield* Fiber.join(interrupted);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(second)));
      } else {
        assert.deepEqual(
          (yield* Fiber.join(second)).map((stored) => stored.event.id),
          ["event:2"],
        );
      }
      assert.equal(commits.length, 1);
    }).pipe(Effect.scoped),
);

it.effect("flushes before a control write and does not let an old timer flush a new window", () =>
  Effect.gen(function* () {
    const order: string[] = [];
    const batch = yield* ProviderCommitBatch.make(
      (events) =>
        Effect.sync(() => {
          order.push(...events.map((event) => event.id));
          return events.map((event, index) => ({ sequence: index + 1, commandId: null, event }));
        }),
      25,
    );
    const first = yield* batch
      .write([event(1)])
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust(10);
    yield* batch.barrier(Effect.sync(() => order.push("stop")));
    yield* Fiber.join(first);
    const next = yield* batch.write([event(2)]).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust(15);
    assert.deepEqual(order, ["event:1", "stop"]);
    yield* TestClock.adjust(10);
    yield* Fiber.join(next);
    assert.deepEqual(order, ["event:1", "stop", "event:2"]);
  }).pipe(Effect.scoped),
);

it.effect("fails every affected writer immediately and accepts the next batch", () =>
  Effect.gen(function* () {
    let fail = true;
    const batch = yield* ProviderCommitBatch.make(
      (events) =>
        fail
          ? Effect.fail("disk full")
          : Effect.succeed(
              events.map((event, index) => ({ sequence: index + 1, commandId: null, event })),
            ),
      25,
    );
    const first = yield* batch
      .write([event(1)])
      .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
    const second = yield* batch
      .write([event(2)])
      .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust(25);
    assert.deepEqual(yield* Fiber.join(first), Exit.fail("disk full"));
    assert.deepEqual(yield* Fiber.join(second), Exit.fail("disk full"));
    fail = false;
    const next = yield* batch.write([event(3)]).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* batch.barrier(Effect.void);
    assert.equal((yield* Fiber.join(next))[0]?.event.id, "event:3");
  }).pipe(Effect.scoped),
);

it.effect("bounds groups by event count and JSON bytes without waiting for the timer", () =>
  Effect.gen(function* () {
    const commits: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    const batch = yield* ProviderCommitBatch.make(
      (events) =>
        Effect.sync(() => {
          commits.push(events);
          return events.map((event, index) => ({ sequence: index + 1, commandId: null, event }));
        }),
      25,
    );
    const first = yield* batch
      .write(Array.from({ length: 63 }, (_, i) => event(i)))
      .pipe(Effect.forkScoped({ startImmediately: true }));
    const second = yield* batch
      .write([event(64)])
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.equal(commits[0]?.length, 64);
    const small = yield* batch
      .write([event(65)])
      .pipe(Effect.forkScoped({ startImmediately: true }));
    const large = yield* batch.write([event(66, "x".repeat(1024 * 1024))]);
    yield* Fiber.join(small);
    assert.deepEqual(
      commits.map((events) => events.length),
      [64, 1, 1],
    );
    assert.equal(large.length, 1);
  }).pipe(Effect.scoped),
);

it.effect(
  "removes interrupted queued writes and flushes outstanding writes when its scope closes",
  () =>
    Effect.gen(function* () {
      const commits: string[] = [];
      const write = (
        events: ReadonlyArray<OrchestrationV2DomainEvent>,
      ): Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>> =>
        Effect.sync(() => {
          commits.push(...events.map((event) => event.id));
          return events.map((event, index) => ({ sequence: index + 1, commandId: null, event }));
        });
      const batch = yield* ProviderCommitBatch.make(write, 25);
      const cancelled = yield* batch
        .write([event(1)])
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.interrupt(cancelled);
      yield* batch.barrier(Effect.void);
      assert.deepEqual(commits, []);
      const parentScope = yield* Effect.scope;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const closing = yield* ProviderCommitBatch.make(write, 25);
          yield* closing
            .write([event(2)])
            .pipe(Effect.forkIn(parentScope, { startImmediately: true }));
        }),
      );
      assert.deepEqual(commits, ["event:2"]);
    }).pipe(Effect.scoped),
);
