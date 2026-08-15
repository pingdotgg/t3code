import type { MessageId } from "@t3tools/contracts";

export async function sendThreadComposerMessage(input: {
  readonly onSendMessage: () => Promise<MessageId | null>;
  readonly onSent: () => void;
}): Promise<MessageId | null> {
  const messageId = await input.onSendMessage();
  if (messageId === null) return null;

  input.onSent();
  return messageId;
}
