import {
  getLastVisibleMessage,
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
  const lastVisibleMessage = getLastVisibleMessage(input.thread.messages);
  if (lastVisibleMessage?.role !== "user") return null;
  return getThreadMessageCorrectionEligibility({
    thread: input.thread,
    targetMessageId: lastVisibleMessage.id,
    occurredAt: input.occurredAt,
  }).eligible
    ? lastVisibleMessage.id
    : null;
}
