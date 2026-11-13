import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";

/** The text a provider receives for a stored message; the stored message stays as written. */
export function providerMessageText(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "text" | "context" | "createdBy" | "senderThreadId" | "linkedSender"
  >,
): string {
  const text = projectComposerContextForProvider({
    text: message.text,
    records: message.context?.records ?? [],
  });
  if (message.createdBy !== "agent") return text;
  const sender =
    message.senderThreadId !== undefined
      ? `thread ${message.senderThreadId}`
      : message.linkedSender !== undefined
        ? `thread ${JSON.stringify(message.linkedSender.title)} in a linked environment`
        : undefined;
  // Providers dispatch native commands only from a leading slash, so those go unmarked.
  if (sender === undefined || text.trimStart().startsWith("/")) return text;
  return `[Sent by the agent in ${sender}, not by the user.]\n\n${text}`;
}
