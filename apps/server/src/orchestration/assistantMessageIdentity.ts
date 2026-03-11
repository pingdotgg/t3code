import {
  MessageId,
  type OrchestrationThread,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

export type AssistantMessageIdentityThread = Pick<
  OrchestrationThread,
  "id" | "messages" | "latestTurn" | "checkpoints"
>;

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function uniqueMessageIds(ids: ReadonlyArray<MessageId>): Array<MessageId> {
  return Array.from(new Set(ids));
}

function legacyAssistantMessageIdsFromRuntimeEvent(event: ProviderRuntimeEvent): Array<MessageId> {
  const ids: Array<MessageId> = [];
  if (event.itemId) {
    ids.push(MessageId.makeUnsafe(`assistant:${event.itemId}`));
  }
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    ids.push(MessageId.makeUnsafe(`assistant:${turnId}`));
  }
  ids.push(MessageId.makeUnsafe(`assistant:${event.eventId}`));
  return uniqueMessageIds(ids);
}

function assistantMessageIdFromTurn(threadId: ThreadId, turnId: TurnId): MessageId {
  return MessageId.makeUnsafe(`assistant:${threadId}:turn:${turnId}`);
}

function persistedAssistantMessageIdForTurn(
  thread: Pick<OrchestrationThread, "messages" | "latestTurn" | "checkpoints">,
  turnId: TurnId,
): MessageId | undefined {
  const messageId = thread.messages
    .toReversed()
    .find((entry) => entry.role === "assistant" && entry.turnId === turnId)?.id;
  if (messageId) {
    return messageId;
  }

  const latestTurnMessageId =
    thread.latestTurn?.turnId === turnId ? thread.latestTurn.assistantMessageId : null;
  if (latestTurnMessageId) {
    return latestTurnMessageId;
  }

  return (
    thread.checkpoints.toReversed().find((entry) => entry.turnId === turnId)?.assistantMessageId ??
    undefined
  );
}

export function assistantMessageIdFromRuntimeEvent(
  event: ProviderRuntimeEvent,
  threadId: ThreadId,
): MessageId {
  const turnId = toTurnId(event.turnId);
  if (event.itemId) {
    return MessageId.makeUnsafe(`assistant:${threadId}:item:${event.itemId}`);
  }
  if (turnId) {
    return assistantMessageIdFromTurn(threadId, turnId);
  }
  return MessageId.makeUnsafe(`assistant:${threadId}:event:${event.eventId}`);
}

export function resolveRuntimeAssistantMessageId(
  thread: AssistantMessageIdentityThread,
  event: ProviderRuntimeEvent,
): MessageId {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    const persistedMessageId = persistedAssistantMessageIdForTurn(thread, turnId);
    if (persistedMessageId) {
      return persistedMessageId;
    }
  }

  const nextMessageId = assistantMessageIdFromRuntimeEvent(event, thread.id);
  const matchingExistingMessageId = thread.messages
    .toReversed()
    .find(
      (entry) =>
        entry.role === "assistant" &&
        uniqueMessageIds([
          nextMessageId,
          ...legacyAssistantMessageIdsFromRuntimeEvent(event),
        ]).includes(entry.id),
    )?.id;

  return matchingExistingMessageId ?? nextMessageId;
}

export function resolveCheckpointAssistantMessageId(input: {
  thread: Pick<OrchestrationThread, "messages" | "latestTurn" | "checkpoints">;
  threadId: ThreadId;
  turnId: TurnId;
  assistantMessageId?: MessageId | null;
}): MessageId {
  return (
    input.assistantMessageId ??
    persistedAssistantMessageIdForTurn(input.thread, input.turnId) ??
    assistantMessageIdFromTurn(input.threadId, input.turnId)
  );
}
