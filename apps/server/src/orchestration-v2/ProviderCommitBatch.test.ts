import { assert, it } from "@effect/vitest";
import { MessageId, ProviderDriverKind, ProviderTurnId, ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
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

const recordBatches = Effect.fn("test.recordProviderBatches")(function* (
  beforeCommit: Effect.Effect<void> = Effect.void,
) {
  const output = yield* Queue.unbounded<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>>();
  let current: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const coordinator = yield* ProviderCommitBatch.make(
    (work) =>
      Effect.gen(function* () {
        yield* beforeCommit;
        current = [];
        yield* work;
        if (current.length > 0) yield* Queue.offer(output, current);
      }),
    true,
  );
  const process = (raw: ProviderAdapter.ProviderAdapterV2Event) =>
    raw.type === "background_work.updated"
      ? Queue.offer(output, [raw]).pipe(Effect.asVoid)
      : Effect.sync(() => {
          current.push(raw);
        });
  return { ...coordinator, process, output };
});

it.effect("publishes preceding snapshots before a control", () =>
  Effect.gen(function* () {
    const recorder = yield* recordBatches();
    const input = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const consumer = yield* recorder
      .consume(Stream.fromQueue(input), recorder.process, Effect.succeed(true))
      .pipe(Effect.forkScoped);
    yield* Queue.offer(input, event(1));
    assert.deepEqual(yield* Queue.take(recorder.output), [event(1)]);
    yield* Queue.offer(input, event(2));
    yield* Queue.offer(input, control);
    assert.deepEqual(yield* Queue.take(recorder.output), [event(2)]);
    assert.deepEqual(yield* Queue.take(recorder.output), [control]);
    yield* Fiber.join(consumer);
  }),
);

it.effect("publishes isolated snapshots without advancing the clock", () =>
  Effect.gen(function* () {
    const recorder = yield* recordBatches();
    const input = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const pulled = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    yield* recorder
      .consume(
        Stream.fromQueue(input).pipe(Stream.tap((raw) => Queue.offer(pulled, raw))),
        recorder.process,
        Effect.succeed(false),
      )
      .pipe(Effect.forkScoped);
    for (const raw of [event(1), event(2)]) {
      yield* Queue.offer(input, raw);
      yield* Queue.take(pulled);
      yield* TestClock.adjust(0);
      const published = yield* Queue.poll(recorder.output);
      assert.equal(published._tag, "Some");
      if (published._tag === "Some") assert.deepEqual(published.value, [raw]);
    }
  }),
);

it.effect("bounds transactions by count and bytes, including the final partial group", () =>
  Effect.gen(function* () {
    const workloads = [
      { events: Array.from({ length: 129 }, (_, index) => event(index)) },
      { events: [event(0), event(1, "x".repeat(1024 * 1024)), event(2)] },
      {
        events: [event(0, "x".repeat(600_000)), event(1, "y".repeat(600_000)), event(2)],
      },
    ];
    for (const { events } of workloads) {
      const recorder = yield* recordBatches();
      const pulled = yield* Deferred.make<void>();
      let arrivals = 0;
      const consumer = yield* recorder
        .consume(
          Stream.fromArray(events).pipe(
            Stream.tap(() =>
              ++arrivals === events.length ? Deferred.succeed(pulled, undefined) : Effect.void,
            ),
          ),
          recorder.process,
          Effect.succeed(false),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(pulled);
      yield* TestClock.adjust(0);
      yield* recorder.barrier(Effect.void);
      yield* Fiber.join(consumer);
      const batches = yield* Queue.takeAll(recorder.output);
      assert.isTrue(batches.every((batch) => batch.length <= 64));
      if (events.length === 129) assert.isTrue(batches.some((batch) => batch.length > 1));
      assert.isTrue(
        batches.every(
          (batch) =>
            batch.length === 1 ||
            batch.reduce((bytes, raw) => bytes + Buffer.byteLength(JSON.stringify(raw)), 0) <=
              1024 * 1024,
        ),
      );
      assert.deepEqual(batches.flat(), events);
    }
  }),
);

it.effect("keeps updates immediate and ordered when batching is disabled", () =>
  Effect.gen(function* () {
    const seen: ProviderAdapter.ProviderAdapterV2Event[] = [];
    const coordinator = yield* ProviderCommitBatch.make(() => Effect.die("must not batch"), false);
    yield* coordinator.consume(
      Stream.make(event(1), control, event(2)),
      (raw) =>
        Effect.sync(() => {
          seen.push(raw);
        }),
      Effect.succeed(false),
    );
    assert.deepEqual(seen, [event(1), control, event(2)]);
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
      const coordinator = yield* recordBatches();
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
            coordinator.process,
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

      yield* coordinator.barrier(Effect.void);
      const batches: Array<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>> = [];
      let count = 0;
      while (count < streams * updates) {
        const batch = yield* Queue.take(coordinator.output);
        batches.push(batch);
        count += batch.length;
      }
      assert.deepEqual(
        batches.map((batch) => batch.length),
        streams * updates > 64 ? [64, 36] : [10],
      );
      assert.equal(
        new Set(
          batches
            .flat()
            .flatMap((raw) => (raw.type === "message.updated" ? [raw.message.text] : [])),
        ).size,
        streams * updates,
      );
      for (const input of inputs) yield* Queue.offer(input, control);
      yield* Effect.forEach(consumers, Fiber.join);
    }),
);

it.effect("does not hold the shared worker while one consumer checks background work", () =>
  Effect.gen(function* () {
    const checking = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const coordinator = yield* ProviderCommitBatch.make((work) => work, true);
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
  }),
);

it.effect.each(["job", "commit"] as const)(
  "isolates a %s failure at its transaction boundary",
  (mode) =>
    Effect.gen(function* () {
      const coordinator = yield* ProviderCommitBatch.make(
        (work) =>
          mode === "commit"
            ? work.pipe(
                Effect.andThen(
                  Effect.fail(new ProviderCommitBatch.CommitBatchError({ cause: "COMMIT failed" })),
                ),
              )
            : work,
        true,
      );
      const inputs = yield* Effect.forEach([0, 1], () =>
        Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>(),
      );
      const consumers = yield* Effect.forEach(inputs, (input, index) =>
        coordinator
          .consume(
            Stream.fromQueue(input),
            () => (mode === "job" && index === 1 ? Effect.fail("invalid update") : Effect.void),
            Effect.succeed(true),
          )
          .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true })),
      );
      for (const input of inputs) yield* Queue.offer(input, event(0));
      yield* TestClock.adjust(0);
      yield* coordinator.barrier(Effect.void);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(consumers[1]!)));
      if (mode === "commit") assert.isTrue(Exit.isFailure(yield* Fiber.join(consumers[0]!)));
      else {
        assert.isUndefined(consumers[0]!.pollUnsafe());
        yield* Queue.offer(inputs[0]!, control);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(consumers[0]!)));
      }
      assert.equal(yield* coordinator.barrier(Effect.succeed("recovered")), "recovered");
      assert.deepEqual(
        yield* coordinator.barrier(Effect.fail("original error")).pipe(Effect.exit),
        Exit.fail("original error"),
      );
    }),
);

it.effect("keeps a transaction failure when rolling back one failed snapshot", () =>
  Effect.gen(function* () {
    const transactionError = new ProviderCommitBatch.CommitBatchError({ cause: "ROLLBACK failed" });
    const coordinator = yield* ProviderCommitBatch.make(
      (work) => work.pipe(Effect.mapError(() => transactionError)),
      true,
    );
    const exit = yield* coordinator
      .consume(
        Stream.concat(Stream.make(event(1)), Stream.never),
        () => Effect.fail("invalid snapshot"),
        Effect.succeed(false),
      )
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) assert.strictEqual(Cause.squash(exit.cause), transactionError);
  }),
);

it.effect(
  "allows a command holding the thread lock to commit while a provider control waits for it",
  () =>
    Effect.gen(function* () {
      const coordinator = yield* ProviderCommitBatch.make((work) => work, true);
      const locks = yield* KeyedLock.make<ThreadId>();
      const threadId = ThreadId.make("locked-thread");
      const held = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const command = yield* locks
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(
            Effect.andThen(Deferred.await(waiting)),
            Effect.andThen(coordinator.barrier(Deferred.succeed(committed, undefined))),
          ),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(held);
      const consumer = yield* coordinator
        .consume(
          Stream.make(control),
          () =>
            Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(locks.withLock(threadId, Effect.void)),
            ),
          Effect.succeed(true),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(waiting);
      yield* TestClock.adjust(0);
      assert.isTrue(yield* Deferred.isDone(committed));
      yield* Fiber.join(command);
      yield* Fiber.join(consumer);
    }),
);

it.effect.each([false, true])(
  "batches work accumulated behind a busy writer with cancellation=%s",
  (cancel) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      const recorder = yield* recordBatches(
        Effect.gen(function* () {
          if (!first) return;
          first = false;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }),
      );
      const leading = yield* recorder
        .consume(Stream.make(event(-1)), recorder.process, Effect.succeed(false))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(started);
      const pulled = yield* Deferred.make<void>();
      let arrivals = 0;
      const consumers = yield* Effect.forEach(Array.from({ length: 10 }), (_, index) =>
        recorder
          .consume(
            Stream.make(event(index)).pipe(
              Stream.tap(() =>
                ++arrivals === 10 ? Deferred.succeed(pulled, undefined) : Effect.void,
              ),
            ),
            recorder.process,
            Effect.succeed(false),
          )
          .pipe(Effect.forkScoped({ startImmediately: true })),
      );
      yield* Deferred.await(pulled);
      yield* TestClock.adjust(0);
      if (cancel) yield* Fiber.interrupt(consumers[0]!);
      assert.equal(yield* Queue.size(recorder.output), 0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(leading);
      yield* Effect.forEach(consumers.slice(cancel ? 1 : 0), Fiber.join);
      assert.deepEqual(yield* Queue.takeAll(recorder.output), [
        [event(-1)],
        Array.from({ length: cancel ? 9 : 10 }, (_, index) => event(index + (cancel ? 1 : 0))),
      ]);
    }),
);

it.effect.each(["failure", "stop"] as const)(
  "flushes the prefix and respects a source %s barrier",
  (mode) =>
    Effect.gen(function* () {
      const seen: ProviderAdapter.ProviderAdapterV2Event[] = [];
      const coordinator = yield* ProviderCommitBatch.make((work) => work, true);
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
    }),
);

it.effect("does not force a separate commit for every consumer that ends", () =>
  Effect.gen(function* () {
    const pulled = yield* Deferred.make<void>();
    let arrivals = 0;
    const coordinator = yield* recordBatches();
    for (let index = 0; index < 10; index++) {
      yield* coordinator
        .consume(
          Stream.make(event(index)).pipe(
            Stream.tap(() =>
              ++arrivals === 10 ? Deferred.succeed(pulled, undefined) : Effect.void,
            ),
          ),
          coordinator.process,
          Effect.succeed(false),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }));
    }
    yield* Deferred.await(pulled);
    yield* TestClock.adjust(0);
    yield* coordinator.barrier(Effect.void);
    assert.deepEqual(
      (yield* Queue.takeAll(coordinator.output)).map((batch) => batch.length),
      [10],
    );
  }),
);

it.effect("settles calls made after the coordinator's scope closes", () =>
  Effect.gen(function* () {
    const coordinator = yield* ProviderCommitBatch.make((work) => work, true).pipe(Effect.scoped);
    const exit = yield* coordinator
      .barrier(Effect.die("must not execute after shutdown"))
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
  }),
);
