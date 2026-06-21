import { EventId, MessageId, ThreadId, TurnId, type OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cacheAssistantMessageForLifecycle,
  readCachedAssistantResponse,
  shouldRelayFinalAssistantResponse,
  shouldForwardLifecycleCheckpoint,
} from "./http.ts";
import type { TrackedExecutionRun } from "./runStart.ts";

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

  it("does not guess a final response without a turn or message id", () => {
    const cache = new Map();

    cacheAssistantMessageForLifecycle({
      cache,
      event: assistantMessageEvent({
        eventId: "event-1",
        messageId: "message-previous",
        text: "Previous turn final",
        streaming: true,
        turnId: "turn-previous",
      }),
    });

    expect(
      readCachedAssistantResponse({
        cache,
        threadId: ThreadId.make("thread-1"),
      }),
    ).toBeUndefined();
  });
});

describe("execution bridge task runtime lifecycle forwarding", () => {
  const taskRun = {
    kind: "task",
    controlThreadId: "task-1",
    executionRunId: "session-1",
    taskId: "task-1",
    workSessionId: "session-1",
    threadId: ThreadId.make("thread-1"),
    startedEventId: null,
    completedEventId: null,
    failedEventId: null,
    interruptedEventId: null,
    lastTurnId: null,
  } satisfies TrackedExecutionRun;

  it("does not treat initial ready session state as task completion before a turn starts", () => {
    expect(
      shouldForwardLifecycleCheckpoint({
        type: "completed",
        trackedRun: taskRun,
      }),
    ).toBe(false);
  });

  it("forwards task completion after a turn has been observed", () => {
    expect(
      shouldForwardLifecycleCheckpoint({
        type: "completed",
        trackedRun: {
          ...taskRun,
          startedEventId: "started-event",
          lastTurnId: TurnId.make("turn-1"),
        },
      }),
    ).toBe(true);
  });
});

describe("execution bridge task runtime assistant relay boundaries", () => {
  it("does not relay a final response when the turn only produced the already relayed first message", () => {
    expect(
      shouldRelayFinalAssistantResponse({
        firstRelay: {
          messageId: "assistant-message-1",
          text: "Done.",
        },
        finalResponse: {
          messageId: "assistant-message-1",
          turnId: "turn-1",
          text: "Done.",
        },
      }),
    ).toBe(false);
  });

  it("relays a final response when it is a distinct assistant message", () => {
    expect(
      shouldRelayFinalAssistantResponse({
        firstRelay: {
          messageId: "assistant-message-1",
          text: "Starting.",
        },
        finalResponse: {
          messageId: "assistant-message-2",
          turnId: "turn-1",
          text: "Done.",
        },
      }),
    ).toBe(true);
  });

  it("relays a final response when the same message id has new final text", () => {
    expect(
      shouldRelayFinalAssistantResponse({
        firstRelay: {
          messageId: "assistant-message-1",
          text: "Starting.",
        },
        finalResponse: {
          messageId: "assistant-message-1",
          turnId: "turn-1",
          text: "Done.",
        },
      }),
    ).toBe(true);
  });

  it("does not relay a final response twice for the same turn", () => {
    expect(
      shouldRelayFinalAssistantResponse({
        firstRelay: {
          messageId: "assistant-message-1",
          text: "Starting.",
        },
        finalRelay: {
          messageId: "assistant-message-2",
          text: "Done.",
        },
        finalResponse: {
          messageId: "assistant-message-2",
          turnId: "turn-1",
          text: "Done.",
        },
      }),
    ).toBe(false);
  });
});
