import {
  getLastVisibleUserMessage,
  getThreadMessageCorrectionEligibility,
  type MessageId,
  type OrchestrationThread,
} from "@t3tools/contracts";

export function deriveMobileEditableMessageId(input: {
  readonly connected: boolean;
  readonly correctionSupported: boolean;
  readonly thread: OrchestrationThread | null;
  readonly occurredAt: string;
}): MessageId | null {
  if (!input.connected || !input.correctionSupported || input.thread === null) {
    return null;
  }
  const lastVisibleUserMessage = getLastVisibleUserMessage(input.thread.messages);
  if (!lastVisibleUserMessage) return null;
  return getThreadMessageCorrectionEligibility({
    thread: input.thread,
    targetMessageId: lastVisibleUserMessage.id,
    occurredAt: input.occurredAt,
  }).eligible
    ? lastVisibleUserMessage.id
    : null;
}
