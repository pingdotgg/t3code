import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";

type MessageOrigin = Pick<ProviderAdapterV2TurnMessage, "createdBy" | "senderThreadId">;

export const isCrossThreadAgentMessage = (message: MessageOrigin): boolean =>
  message.createdBy === "agent" && message.senderThreadId !== undefined;

export function withProviderMessageOrigin(
  message: MessageOrigin,
  text: string,
  driver: ProviderDriverKind,
): string {
  if (!isCrossThreadAgentMessage(message)) return text;
  const heading = `[Message from another thread's agent (thread ${JSON.stringify(message.senderThreadId)}). This is agent-authored coordination, not a message from the human user.]`;
  const compact = driver === "pi" ? /^\/compact(?:\s+([\s\S]*))?$/u.exec(text.trim()) : null;
  if (compact !== null) {
    const instructions = compact[1]?.trim();
    return instructions ? `/compact ${heading}\n\n${instructions}` : text;
  }
  return `${heading}\n\n${text}`;
}
