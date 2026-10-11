import {
  EventId,
  MessageId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import {
  coalesceThreadLiveStream,
  makeThreadLiveEventCoalescer,
} from "./ThreadLiveEventCoalescer.ts";

type ThreadEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>;
const threadId = ThreadId.make("thread-coalescer-test");
const runId = RunId.make("run-coalescer-test");
const now = DateTime.makeUnsafe("2026-01-01T00:00:01.000Z");
const encodeEvent = JSON.stringify;

function makeToolActivity(
  sequence: number,
  options: {
    readonly kind?: "tool.updated" | "tool.completed";
    readonly toolCallId?: string;
    readonly turnId?: RunId;
    readonly output?: string;
  } = {},
): ThreadEvent {
  const itemRunId = options.turnId ?? runId;
  const status = options.kind === "tool.completed" ? "completed" : "running";
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      type: "turn-item.updated",
      threadId,
      runId: itemRunId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(options.toolCallId ?? "call-edit"),
        type: "command_execution",
        threadId,
        runId: itemRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status,
        title: "Editing app.ts",
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        updatedAt: now,
        input: "echo app.ts",
        output: options.output ?? `output-${sequence}`,
      },
    },
  };
}

function makeMessage(sequence: number, text = "Still working"): ThreadEvent {
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      type: "message.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: MessageId.make(`message-${sequence}`),
        threadId,
        runId,
        nodeId: null,
        createdBy: "agent",
        creationSource: "provider",
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

describe("ThreadLiveEventCoalescer", () => {
  it.effect("flushes pending tool updates as soon as an unrelated event arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ coalesceWindow: "500 millis" });
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Effect.forEach(
          Array.from({ length: 10 }, (_, index) => index + 2),
          (sequence) => coalescer.offer(makeToolActivity(sequence)),
          { discard: true },
        );
        yield* coalescer.offer(makeMessage(12));

        expect(yield* Clock.currentTimeMillis).toBe(startedAt);
        expect(
          (yield* coalescer.stream.pipe(Stream.take(2), Stream.runCollect)).map((item) =>
            item.kind === "event" ? item.sequence : item.kind,
          ),
        ).toEqual([11, 12]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("flushes pending tool updates as soon as a synchronization marker arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ coalesceWindow: "500 millis" });
        const startedAt = yield* Clock.currentTimeMillis;
        yield* coalescer.offer(makeToolActivity(2));
        yield* coalescer.offer(makeToolActivity(3));
        yield* coalescer.offer({ kind: "synchronized" });

        expect(yield* Clock.currentTimeMillis).toBe(startedAt);
        expect(
          (yield* coalescer.stream.pipe(Stream.take(2), Stream.runCollect)).map((item) =>
            item.kind === "event" ? item.sequence : item.kind,
          ),
        ).toEqual([3, "synchronized"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails and clears pending updates when their serialized payload fills the budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = makeToolActivity(1);
        const coalescer = yield* makeThreadLiveEventCoalescer({
          coalesceWindow: "500 millis",
          maxSerializedBytes: Buffer.byteLength(encodeEvent(first)),
        });
        yield* coalescer.offer(first);
        expect(yield* coalescer.usage).toEqual({
          retainedItems: 1,
          retainedSerializedBytes: Buffer.byteLength(encodeEvent(first)),
        });

        const overflow = yield* coalescer
          .offer(makeToolActivity(2, { toolCallId: "another-call" }))
          .pipe(Effect.result);
        expect(overflow._tag).toBe("Failure");
        yield* coalescer.closed;
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
        const marker = yield* coalescer.offer({ kind: "synchronized" }).pipe(Effect.result);
        expect(marker._tag).toBe("Failure");
        const delivered = yield* coalescer.stream.pipe(Stream.runCollect, Effect.result);
        expect(delivered._tag).toBe("Failure");
      }),
    ),
  );

  it.effect.each(["items", "bytes"] as const)(
    "replaces superseded tool output before charging the %s budget",
    (limit) =>
      Effect.scoped(
        Effect.gen(function* () {
          const updates = Array.from({ length: 1_100 }, (_, index) => makeToolActivity(index + 1));
          const latest = updates.at(-1)!;
          const coalescer = yield* makeThreadLiveEventCoalescer({
            coalesceWindow: "500 millis",
            ...(limit === "items"
              ? { maxItems: 1 }
              : { maxSerializedBytes: Buffer.byteLength(encodeEvent(latest)) }),
          });
          yield* coalescer.offerAll(updates);
          expect(yield* coalescer.usage).toEqual({
            retainedItems: 1,
            retainedSerializedBytes: Buffer.byteLength(encodeEvent(latest)),
          });
          yield* coalescer.end;
          expect(yield* coalescer.stream.pipe(Stream.runCollect)).toEqual([latest]);
          expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
        }),
      ),
  );

  it.effect("retains parallel calls in last-update order across a completion boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer();
        const events = [
          makeToolActivity(1, { toolCallId: "call-a" }),
          makeToolActivity(2, { toolCallId: "call-b" }),
          makeToolActivity(3, { toolCallId: "call-a" }),
          makeToolActivity(4, { toolCallId: "call-a", kind: "tool.completed" }),
          makeToolActivity(5, { toolCallId: "call-a" }),
          makeToolActivity(6, { toolCallId: "call-a", turnId: RunId.make("another-run") }),
          makeToolActivity(7, { toolCallId: "call-a" }),
        ];
        yield* coalescer.offerAll(events);
        yield* coalescer.end;
        expect(yield* coalescer.stream.pipe(Stream.runCollect)).toEqual([
          events[1],
          events[2],
          events[3],
          events[5],
          events[6],
        ]);
      }),
    ),
  );

  it.effect("handles a tool output burst larger than the default 8 MiB buffer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer();
        const updates = Array.from({ length: 150 }, (_, index) =>
          makeToolActivity(index + 1, { output: "x".repeat(64 * 1024) }),
        );
        yield* coalescer.offerAll(updates);
        yield* coalescer.end;
        expect(yield* coalescer.stream.pipe(Stream.runCollect)).toEqual([updates.at(-1)]);
      }),
    ),
  );

  it.effect("still fails when a single replacement exceeds the byte budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = makeToolActivity(1);
        const coalescer = yield* makeThreadLiveEventCoalescer({
          maxSerializedBytes: Buffer.byteLength(encodeEvent(first)),
        });
        yield* coalescer.offer(first);
        const overflow = yield* coalescer
          .offer(makeToolActivity(2, { output: "x".repeat(2_000) }))
          .pipe(Effect.result);
        expect(overflow._tag).toBe("Failure");
        yield* coalescer.closed;
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );

  it.effect("does not postpone delivery when a running tool keeps replacing its output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ coalesceWindow: "50 millis" });
        yield* coalescer.offer(makeToolActivity(1));
        yield* TestClock.adjust("25 millis");
        const latest = makeToolActivity(2);
        yield* coalescer.offer(latest);
        yield* TestClock.adjust("25 millis");
        expect(yield* coalescer.stream.pipe(Stream.take(1), Stream.runCollect)).toEqual([latest]);
      }),
    ),
  );

  it.effect("keeps the flush timer alive when an offer's shorter scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ coalesceWindow: "50 millis" });
        yield* Effect.scoped(coalescer.offer(makeToolActivity(1)));
        yield* TestClock.adjust("50 millis");
        const items = yield* coalescer.stream.pipe(Stream.take(1), Stream.runCollect);
        expect(items.map((item) => (item.kind === "event" ? item.sequence : item.kind))).toEqual([
          1,
        ]);
      }),
    ),
  );

  it.effect("keeps an unacknowledged batch charged and clears later events on overflow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ maxItems: 3 });
        const first = makeMessage(1, "é".repeat(1_024));
        yield* coalescer.offer(first);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(coalescer.stream);
            const batch = yield* pull;
            expect(batch.map((item) => (item.kind === "event" ? item.sequence : null))).toEqual([
              1,
            ]);
            yield* coalescer.offer(makeMessage(2));
            yield* coalescer.offer(makeToolActivity(3));
            expect((yield* coalescer.usage).retainedItems).toBe(3);

            const overflow = yield* coalescer
              .offer(makeToolActivity(4, { kind: "tool.completed" }))
              .pipe(Effect.result);
            expect(overflow._tag).toBe("Failure");
            // Do not pull or acknowledge the batch. Cleanup must still finish.
            yield* coalescer.closed;
            expect(yield* coalescer.usage).toEqual({
              retainedItems: 1,
              retainedSerializedBytes: Buffer.byteLength(encodeEvent(first)),
            });
          }),
        );
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );
});

it.effect("flushes the last update before a finite source ends", () =>
  Effect.gen(function* () {
    const result = yield* Stream.make(makeToolActivity(1), makeToolActivity(2)).pipe(
      coalesceThreadLiveStream,
      Stream.runCollect,
    );
    expect(result.map((item) => (item.kind === "event" ? item.sequence : null))).toEqual([2]);
  }),
);

it.effect("propagates an upstream failure instead of leaving the subscriber waiting", () =>
  Effect.gen(function* () {
    const result = yield* Stream.fail("source stopped").pipe(
      coalesceThreadLiveStream,
      Stream.runCollect,
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBe("source stopped");
  }),
);
