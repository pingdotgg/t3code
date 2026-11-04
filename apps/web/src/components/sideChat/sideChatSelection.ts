import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  AssistantCitation,
  OrchestrationV2SideChatAnchor,
  ThreadId,
} from "@t3tools/contracts";

/** Where the selection sits, without its text: the side chat keeps the excerpt itself. */
export function sideChatAnchorFromCitation(
  citation: AssistantCitation,
  embedTitle?: string,
): OrchestrationV2SideChatAnchor {
  return {
    ...(embedTitle === undefined ? {} : { embedTitle }),
    threadId: citation.threadId,
    messageId: citation.messageId,
    start: citation.start,
    end: citation.end,
    prefix: citation.prefix,
    suffix: citation.suffix,
  };
}

/**
 * A side chat already asked about part of the selection: its highlight shares at
 * least one character with it in the same reply of the same thread.
 */
export function findOverlappingSideChat(
  shells: ReadonlyArray<Pick<EnvironmentThreadShell, "id" | "sideChat">>,
  selection: Pick<AssistantCitation, "threadId" | "messageId" | "start" | "end">,
): ThreadId | null {
  const overlapping = shells.find(({ sideChat }) => {
    const anchor = sideChat?.anchor;
    return (
      anchor !== undefined &&
      anchor.threadId === selection.threadId &&
      anchor.messageId === selection.messageId &&
      anchor.start < selection.end &&
      selection.start < anchor.end
    );
  });
  return overlapping?.id ?? null;
}
