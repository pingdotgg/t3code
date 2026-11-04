import { assert, it } from "@effect/vitest";
import { MessageId, ProviderDriverKind, ProviderTurnId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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

it.effect.each([
  { streams: 1, updates: 10 },
  { streams: 10, updates: 1 },
  { streams: 10, updates: 10 },
])(
  "shares bounded transactions across $streams streams with $updates updates each",
  ({ streams, updates }) =>
    Effect.gen(function* () {
      const commits = yield* Queue.unbounded<ReadonlyArray<string>>();
      let transaction: string[] = [];
      const coordinator = yield* ProviderCommitBatch.make(
        (work) =>
          Effect.gen(function* () {
            transaction = [];
            yield* work;
            yield* Queue.offer(commits, transaction);
          }),
        10,
      );
      const inputs = yield* Effect.forEach(Array.from({ length: streams }), () =>
        Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>(),
      );
      const pulled = yield* Deferred.make<void>();
      let arrivals = 0;
      const consumers = yield* Effect.forEach(inputs, (input) =>
        coordinator
          .consume(
            Stream.fromQueue(input).pipe(
              Stream.tap(() => {
                arrivals++;
                return arrivals === streams * updates
                  ? Deferred.succeed(pulled, undefined)
                  : Effect.void;
              }),
            ),
            (raw) =>
              Effect.sync(() => {
                if (raw.type === "message.updated") transaction.push(raw.message.text);
              }),
            Effect.succeed(true),
          )
          .pipe(Effect.forkScoped({ startImmediately: true })),
      );
      for (let n = 0; n < updates; n++) {
        for (let stream = 0; stream < streams; stream++)
          yield* Queue.offer(inputs[stream]!, event(stream * updates + n));
      }
      yield* Deferred.await(pulled);
      yield* TestClock.adjust(0);
      if (updates === 1) assert.equal(yield* Queue.size(commits), 0);
      yield* coordinator.barrier(Effect.void);
      const batches: ReadonlyArray<string>[] = [];
      let count = 0;
      while (count < streams * updates) {
        const batch = yield* Queue.take(commits);
        batches.push(batch);
        count += batch.length;
      }
      assert.deepEqual(
        batches.map((batch) => batch.length),
        streams * updates > 64 ? [64, 36] : [10],
      );
      assert.equal(new Set(batches.flat()).size, streams * updates);
      for (const input of inputs) yield* Queue.offer(input, control);
      yield* Effect.forEach(consumers, Fiber.join);
    }).pipe(Effect.scoped),
);

it.effect("does not hold the shared worker while one consumer checks background work", () =>
  Effect.gen(function* () {
    const checking = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const coordinator = yield* ProviderCommitBatch.make((work) => work, 10);
    const consumer = yield* coordinator
      .consume(
        Stream.make(control),
        () => Effect.void,
        Deferred.succeed(checking, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(true),
        ),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.await(checking);
    assert.equal(
      yield* coordinator.barrier(Effect.succeed("another run can commit")),
      "another run can commit",
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(consumer);
  }).pipe(Effect.scoped),
);

it.effect(
  "fails every participant of a failed transaction and continues serving unrelated runs",
  () =>
    Effect.gen(function* () {
      const coordinator = yield* ProviderCommitBatch.make((work) => work, 10);
      const inputs = yield* Effect.forEach([0, 1], () =>
        Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>(),
      );
      const failures = yield* Effect.forEach(inputs, (input, index) =>
        coordinator
          .consume(
            Stream.fromQueue(input),
            () => (index === 1 ? Effect.fail("disk full") : Effect.void),
            Effect.succeed(false),
          )
          .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true })),
      );
      for (const input of inputs) yield* Queue.offer(input, event(0));
      yield* TestClock.adjust(0);
      yield* coordinator.barrier(Effect.void);
      for (const failed of failures) assert.isTrue(Exit.isFailure(yield* Fiber.join(failed)));
      assert.equal(yield* coordinator.barrier(Effect.succeed("recovered")), "recovered");
      assert.deepEqual(
        yield* coordinator.barrier(Effect.fail("original error")).pipe(Effect.exit),
        Exit.fail("original error"),
      );
    }).pipe(Effect.scoped),
);

it.effect("cancels pending work from one consumer without cancelling its neighbours", () =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    let writes = 0;
    const coordinator = yield* ProviderCommitBatch.make(
      (work) => work.pipe(Effect.tap(() => Deferred.succeed(committed, undefined))),
      10,
    );
    const inputs = yield* Effect.forEach([0, 1], () =>
      Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>(),
    );
    const consumers = yield* Effect.forEach(inputs, (input) =>
      coordinator
        .consume(
          Stream.fromQueue(input),
          () =>
            Effect.sync(() => {
              writes++;
            }),
          Effect.succeed(true),
        )
        .pipe(Effect.forkScoped({ startImmediately: true })),
    );
    for (const input of inputs) yield* Queue.offer(input, event(0));
    yield* TestClock.adjust(0);
    yield* Fiber.interrupt(consumers[0]!);
    yield* coordinator.barrier(Effect.void);
    yield* Deferred.await(committed);
    assert.equal(writes, 1);
    yield* Queue.offer(inputs[1]!, control);
    yield* Fiber.join(consumers[1]!);
  }).pipe(Effect.scoped),
);

it.effect.each(["failure", "stop"] as const)(
  "flushes the prefix and respects a source %s barrier",
  (mode) =>
    Effect.gen(function* () {
      const seen: ProviderAdapter.ProviderAdapterV2Event[] = [];
      const coordinator = yield* ProviderCommitBatch.make((work) => work, 10);
      const source =
        mode === "failure"
          ? Stream.concat(Stream.make(event(1), event(2)), Stream.fail("provider failed"))
          : Stream.make(event(1), control, event(2));
      const exit = yield* coordinator
        .consume(
          source,
          (raw) =>
            Effect.sync(() => {
              seen.push(raw);
            }),
          Effect.succeed(mode === "stop"),
        )
        .pipe(Effect.exit);
      assert.deepEqual(seen, mode === "failure" ? [event(1), event(2)] : [event(1), control]);
      assert.equal(Exit.isFailure(exit), mode === "failure");
      assert.equal(
        yield* coordinator.barrier(Effect.succeed("still available")),
        "still available",
      );
    }).pipe(Effect.scoped),
);

it.effect("does not force a separate commit for every consumer that ends", () =>
  Effect.gen(function* () {
    const pulled = yield* Deferred.make<void>();
    const writes: number[] = [];
    let arrivals = 0;
    let count = 0;
    const coordinator = yield* ProviderCommitBatch.make(
      (work) =>
        Effect.gen(function* () {
          count = 0;
          yield* work;
          writes.push(count);
        }),
      10,
    );
    for (let index = 0; index < 10; index++) {
      yield* coordinator
        .consume(
          Stream.make(event(index)).pipe(
            Stream.tap(() =>
              ++arrivals === 10 ? Deferred.succeed(pulled, undefined) : Effect.void,
            ),
          ),
          () =>
            Effect.sync(() => {
              count++;
            }),
          Effect.succeed(false),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }));
    }
    yield* Deferred.await(pulled);
    yield* TestClock.adjust(0);
    yield* coordinator.barrier(Effect.void);
    assert.deepEqual(writes, [10]);
  }).pipe(Effect.scoped),
);

it.effect("settles calls made after the coordinator's scope closes", () =>
  Effect.gen(function* () {
    const coordinator = yield* ProviderCommitBatch.make((work) => work, 10).pipe(Effect.scoped);
    const exit = yield* coordinator
      .barrier(Effect.die("must not execute after shutdown"))
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
  }),
);
