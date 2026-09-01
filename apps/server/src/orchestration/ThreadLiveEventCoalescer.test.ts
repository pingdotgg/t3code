import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import {
  coalesceLiveToolUpdatedEvents,
  makeThreadLiveEventCoalescer,
} from "./ThreadLiveEventCoalescer.ts";

const threadId = ThreadId.make("thread-coalescer-test");
const turnId = TurnId.make("turn-coalescer-test");

function makeToolActivity(
  sequence: number,
  options: {
    readonly kind?: "tool.updated" | "tool.completed";
    readonly toolCallId?: string;
    readonly turnId?: TurnId;
  } = {},
): OrchestrationEvent {
  const {
    kind = "tool.updated",
    toolCallId = "call-edit",
    turnId: activityTurnId = turnId,
  } = options;
  const activity: OrchestrationThreadActivity = {
    id: EventId.make(`activity-${sequence}`),
    tone: "tool",
    kind,
    summary: "Editing app.ts",
    payload: {
      itemType: "file_change",
      title: "Editing app.ts",
      data: toolCallId ? { toolCallId } : {},
    },
    turnId: activityTurnId,
    createdAt: "2026-01-01T00:00:01.000Z",
  };
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: { threadId, activity },
  };
}

function makeMessage(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-01-01T00:00:02.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make(`message-${sequence}`),
      role: "assistant",
      text: "Still working",
      turnId,
      streaming: false,
      createdAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    },
  };
}

describe("ThreadLiveEventCoalescer", () => {
  it("coalesces only calls with a stable toolCallId", () => {
    const events = [
      makeToolActivity(1, { toolCallId: "call-a" }),
      makeToolActivity(2, { toolCallId: "call-b" }),
      makeToolActivity(3, { toolCallId: "call-a" }),
    ];

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("preserves parallel same-label calls without a stable toolCallId", () => {
    const events = [
      makeToolActivity(1, { toolCallId: "" }),
      makeToolActivity(2, { toolCallId: "" }),
      makeToolActivity(3, { kind: "tool.completed", toolCallId: "" }),
    ];

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("does not coalesce stable tool calls across turns", () => {
    const events = [
      makeToolActivity(1, { turnId: TurnId.make("turn-old") }),
      makeToolActivity(2, { turnId: TurnId.make("turn-new") }),
    ];

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("flushes a stable update run before a completion boundary", () => {
    const events = [
      makeToolActivity(1),
      makeToolActivity(2),
      makeToolActivity(3, { kind: "tool.completed" }),
      makeToolActivity(4),
    ];

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([2, 3, 4]);
  });

  it.effect("flushes pending tool updates as soon as an unrelated event arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ coalesceWindow: "500 millis" });
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Effect.forEach(
          Array.from({ length: 10 }, (_, index) => index + 2),
          (sequence) =>
            coalescer.offerAndWait({ kind: "event", event: makeToolActivity(sequence) }),
          { discard: true },
        );
        yield* coalescer.offerAndWait({ kind: "event", event: makeMessage(12) });

        expect(yield* Clock.currentTimeMillis).toBe(startedAt);
        expect(
          Array.from(yield* coalescer.takeAll).map((item) =>
            item.kind === "event" ? item.event.sequence : item.kind,
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
        yield* coalescer.offerAndWait({ kind: "event", event: makeToolActivity(2) });
        yield* coalescer.offerAndWait({ kind: "event", event: makeToolActivity(3) });
        yield* coalescer.offerAndWait({ kind: "synchronized" });

        expect(yield* Clock.currentTimeMillis).toBe(startedAt);
        expect(
          Array.from(yield* coalescer.takeAll).map((item) =>
            item.kind === "event" ? item.event.sequence : item.kind,
          ),
        ).toEqual([3, "synchronized"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
