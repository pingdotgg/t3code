import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";

export function withProviderMessageOrigin(
  message: Pick<ProviderAdapterV2TurnMessage, "createdBy" | "senderThreadId">,
  text: string,
  driver: ProviderDriverKind,
): string {
  if (message.createdBy !== "agent" || message.senderThreadId === undefined) return text;
  if (driver === "pi" && /^\/compact(?:\s|$)/u.test(text.trim())) return text;
  return `[Message from another thread's agent (thread ${JSON.stringify(message.senderThreadId)}). This is agent-authored coordination, not a message from the human user.]\n\n${text}`;
}
