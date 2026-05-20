import { EventId, MessageId, ThreadId, TurnId, type OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { cacheAssistantMessageForLifecycle, readCachedAssistantResponse } from "./http.ts";

function assistantMessageEvent(input: {
  readonly eventId: string;
  readonly messageId: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly turnId?: string;
}): Extract<OrchestrationEvent, { type: "thread.message-sent" }> {
  const occurredAt = "2026-05-12T22:58:30.000Z";
  return {
    sequence: 1,
    eventId: EventId.make(input.eventId),
    type: "thread.message-sent",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make(input.messageId),
      role: "assistant",
      text: input.text,
      turnId: input.turnId === undefined ? null : TurnId.make(input.turnId),
      streaming: input.streaming,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  };
}

describe("execution bridge assistant response cache", () => {
  it("caches streaming assistant text for the lifecycle completion callback", () => {
    const cache = new Map();

    cacheAssistantMessageForLifecycle({
      cache,
      event: assistantMessageEvent({
        eventId: "event-1",
        messageId: "message-1",
        text: "Let me explore the repository",
        streaming: true,
        turnId: "turn-1",
      }),
    });

    expect(
      readCachedAssistantResponse({
        cache,
        threadId: ThreadId.make("thread-1"),
        assistantMessageId: "message-1",
        turnId: TurnId.make("turn-1"),
      }),
    ).toBe("Let me explore the repository");
  });

  it("keeps only the latest assistant response for a completed turn", () => {
    const cache = new Map();

    cacheAssistantMessageForLifecycle({
      cache,
      event: assistantMessageEvent({
        eventId: "event-1",
        messageId: "message-1",
        text: "First message",
        streaming: true,
        turnId: "turn-1",
      }),
    });
    cacheAssistantMessageForLifecycle({
      cache,
      event: assistantMessageEvent({
        eventId: "event-2",
        messageId: "message-1",
        text: "",
        streaming: false,
        turnId: "turn-1",
      }),
    });

    cacheAssistantMessageForLifecycle({
      cache,
      event: assistantMessageEvent({
        eventId: "event-3",
        messageId: "message-2",
        text: "Final answer",
        streaming: true,
        turnId: "turn-1",
      }),
    });
    cacheAssistantMessageForLifecycle({
      cache,
      event: assistantMessageEvent({
        eventId: "event-4",
        messageId: "message-2",
        text: "",
        streaming: false,
        turnId: "turn-1",
      }),
    });

    expect(
      readCachedAssistantResponse({
        cache,
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
      }),
    ).toBe("Final answer");
  });
});
