import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";

const LEADING_SKILL_MENTION = new RegExp(`^\\s*${SKILL_MENTION_PATTERN.source}`, "u");

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
  if (sender === undefined) return text;
  const note = `[Sent by the agent in ${sender}, not by the user.]`;
  // Providers dispatch a native command only from a leading slash, where a note would become
  // part of the command. A leading skill mention must stay first; the note follows as its input.
  if (text.trimStart().startsWith("/")) return text;
  return LEADING_SKILL_MENTION.test(text) ? `${text}\n\n${note}` : `${note}\n\n${text}`;
}
