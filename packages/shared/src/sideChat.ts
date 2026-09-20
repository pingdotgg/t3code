import type { OrchestrationMessage } from "@t3tools/contracts";

export const SIDE_MESSAGE_PREFIX = "conversation-side:";

// Copied messages seed only the new side session, never resume the parent session.
export function sideChatHistory(messages: readonly OrchestrationMessage[]) {
  return messages.filter((message) => message.id.startsWith(SIDE_MESSAGE_PREFIX));
}
