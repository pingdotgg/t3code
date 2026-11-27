import {
  EventId,
  MessageId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** One message of history that a thread brings in from outside its own runs. */
export interface ImportedHistoryMessage {
  readonly role: "user" | "assistant" | "reasoning";
  readonly text: string;
  readonly createdAt: string;
}

/**
 * The run-less `message.updated` and `turn-item.updated` events for the imported
 * message at `index`. Ids are stable per thread and slot, and `eventPrefix` keeps
 * the ids of different import paths apart.
 */
export function importedMessageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: ImportedHistoryMessage;
  readonly eventPrefix: string;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(`${input.eventPrefix}:turn-item:${input.threadId}:${suffix}`);
  const at = DateTime.makeUnsafe(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(turnItemId),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload,
  });
  if (input.message.role === "reasoning") {
    return [
      turnItemEvent({ ...common, type: "reasoning", text: input.message.text, streaming: false }),
    ];
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${input.eventPrefix}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    turnItemEvent(turnItem),
  ];
}

/** The run-less notice that `omittedMessageCount` older messages were left out of the import. */
export function importedHistoryTruncatedEvent(input: {
  readonly threadId: ThreadId;
  readonly at: DateTime.Utc;
  readonly omittedMessageCount: number;
  readonly eventPrefix: string;
}): OrchestrationV2DomainEvent {
  const { threadId, at, omittedMessageCount, eventPrefix } = input;
  return {
    id: EventId.make(`${eventPrefix}:history-truncated:${threadId}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make(`${eventPrefix}:history-truncated:${threadId}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "system_notice",
      message: `${omittedMessageCount} earlier ${omittedMessageCount === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
    },
  };
}
