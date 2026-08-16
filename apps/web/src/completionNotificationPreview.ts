import type { MessageId, OrchestrationMessage, TurnId } from "@t3tools/contracts";
import { formatAgentCompletionPreview } from "@t3tools/shared/agentAwareness";

export function completionNotificationPreview(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly assistantMessageId: MessageId | null;
  readonly turnId: TurnId | null;
}): string | null {
  const finalAssistantMessage =
    input.assistantMessageId === null
      ? null
      : (input.messages.find(
          (message) =>
            message.id === input.assistantMessageId &&
            message.role === "assistant" &&
            !message.streaming,
        ) ?? null);
  const latestTurnAssistantMessage =
    finalAssistantMessage ??
    (input.turnId === null
      ? null
      : (input.messages.findLast(
          (message) =>
            message.turnId === input.turnId && message.role === "assistant" && !message.streaming,
        ) ?? null));
  const latestAssistantMessage =
    latestTurnAssistantMessage ??
    (input.assistantMessageId === null && input.turnId === null
      ? (input.messages.findLast((message) => message.role === "assistant" && !message.streaming) ??
        null)
      : null);

  return formatAgentCompletionPreview(latestAssistantMessage?.text ?? "");
}
