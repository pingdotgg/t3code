import { assert, it } from "@effect/vitest";
import { MessageId, ProviderDriverKind, ProviderTurnId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderCommitBatch from "./ProviderCommitBatch.ts";

const driver = ProviderDriverKind.make("codex");
function event(index: number, text = `delta:${index}`): ProviderAdapter.ProviderAdapterV2Event {
  const threadId = ThreadId.make("single-thread");
  const now = DateTime.makeUnsafe("2026-11-03T00:00:00Z");
  return {
    type: "message.updated",
    driver,
    message: {
      id: MessageId.make("single-message"),
      threadId,
      runId: null,
      nodeId: null,
      createdBy: "agent",
      creationSource: "provider",
      role: "assistant",
      text,
      attachments: [],
      streaming: true,
      createdAt: now,
      updatedAt: now,
    },
  };
}
const control: ProviderAdapter.ProviderAdapterV2Event = {
  type: "background_work.updated",
  driver,
  providerTurnId: ProviderTurnId.make("turn"),
  pending: false,
};

it.effect(
  "collects successive updates from one stream and flushes before control without waiting for the window",
  () =>
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
      const output =
        yield* Queue.unbounded<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>>();
      const consumer = yield* ProviderCommitBatch.group(Stream.fromQueue(input), 25).pipe(
        Stream.runForEach((batch) => Queue.offer(output, batch.events)),
        Effect.forkScoped,
      );
      yield* Queue.offer(input, event(1));
      yield* TestClock.adjust(5);
      yield* Queue.offer(input, event(2));
      yield* Queue.offer(input, control);
      const first = yield* Queue.take(output);
      const second = yield* Queue.take(output);
      assert.deepEqual(first, [event(1), event(2)]);
      assert.deepEqual(second, [control]);
      yield* Queue.end(input);
      yield* Fiber.join(consumer);
    }).pipe(Effect.scoped),
);

it.effect("flushes a sparse stream on the deadline and restarts the next window", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    const output = yield* Queue.unbounded<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>>();
    const consumer = yield* ProviderCommitBatch.group(Stream.fromQueue(input), 25).pipe(
      Stream.runForEach((batch) => Queue.offer(output, batch.events)),
      Effect.forkScoped,
    );
    yield* Queue.offer(input, event(1));
    yield* TestClock.adjust(25);
    assert.deepEqual(yield* Queue.take(output), [event(1)]);
    yield* Queue.offer(input, event(2));
    yield* TestClock.adjust(24);
    assert.isTrue((yield* Queue.poll(output))._tag === "None");
    yield* TestClock.adjust(1);
    assert.deepEqual(yield* Queue.take(output), [event(2)]);
    yield* Queue.end(input);
    yield* Fiber.join(consumer);
  }).pipe(Effect.scoped),
);

it.effect("bounds transaction groups by count and bytes and flushes the final partial group", () =>
  Effect.gen(function* () {
    const events = Array.from({ length: 129 }, (_, index) => event(index));
    const batches = yield* ProviderCommitBatch.group(Stream.fromArray(events), 25).pipe(
      Stream.runCollect,
    );
    assert.deepEqual(
      batches.map((batch) => batch.events.length),
      [64, 64, 1],
    );
    assert.deepEqual(
      batches.flatMap((batch) => batch.events),
      events,
    );
    const large = event(1, "x".repeat(1024 * 1024));
    const sized = yield* ProviderCommitBatch.group(Stream.make(event(0), large, event(2)), 25).pipe(
      Stream.runCollect,
    );
    assert.deepEqual(
      sized.map((batch) => batch.events.length),
      [1, 1, 1],
    );
    assert.deepEqual(
      sized.flatMap((batch) => batch.events),
      [event(0), large, event(2)],
    );
  }),
);

it.effect("delivers the pending prefix before propagating a source failure", () =>
  Effect.gen(function* () {
    const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const exit = yield* ProviderCommitBatch.group(
      Stream.concat(Stream.make(event(1), event(2)), Stream.fail("provider failed")),
      25,
    ).pipe(
      Stream.runForEach((batch) => Effect.sync(() => observed.push(...batch.events))),
      Effect.exit,
    );
    assert.deepEqual(observed, [event(1), event(2)]);
    assert.deepEqual(exit, Exit.fail("provider failed"));
  }),
);

it.effect("keeps controls and individual writes immediate when the window is disabled", () =>
  Effect.gen(function* () {
    const batches = yield* ProviderCommitBatch.group(
      Stream.make(event(1), control, event(2)),
      0,
    ).pipe(Stream.runCollect);
    assert.deepEqual(
      batches.map((batch) => batch.events),
      [[event(1)], [control], [event(2)]],
    );
  }),
);
