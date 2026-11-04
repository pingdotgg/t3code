import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { buildThreadMessageLink } from "@t3tools/shared/promptLinks";
import type { ThreadFeedMessage } from "../../lib/threadActivity";

/** Local feedback and anchored creation prompts have no persisted server turn item. */
export function persistedMessageLink(threadRef: ScopedThreadRef, message: ThreadFeedMessage) {
  return message.projectedItem === undefined ? null : { ...threadRef, messageId: message.id };
}

export function resolveMessageCopyContent(
  text: string,
  messageLink: Parameters<typeof buildThreadMessageLink>[0] | null,
) {
  if (text.trim().length > 0) return { kind: "text" as const, text };
  return messageLink === null
    ? null
    : { kind: "message-link" as const, text: buildThreadMessageLink(messageLink) };
}

export function linkedMessageFoldRowId(
  message: Parameters<typeof resolveUserMessagePresentation>[0] & { readonly id: string },
  expandedRows: Readonly<Record<string, boolean>>,
) {
  const { attribution } = resolveUserMessagePresentation(message);
  if (attribution !== "agent" && attribution !== "automation") return null;
  const rowId = `${attribution}:${message.id}`;
  return expandedRows[rowId] ? null : rowId;
}

/**
 * The next thing the feed does to open at a linked message. Used by `ThreadFeed` until it scrolls
 * to the message or reports it missing.
 */
export function resolveLinkedMessageStep(input: {
  /** The message is a row of the presented feed. */
  readonly presented: boolean;
  /** The thread holds the message, even if the feed does not present it. */
  readonly inFeed: boolean;
  /** The collapsed turn that hides the message, when one does. */
  readonly foldedRunId: string | null;
  readonly foldedRowId: string | null;
  /** The thread has caught up with the server, so a message it lacks is older history. */
  readonly synced?: boolean;
  readonly syncStatus?: EnvironmentThreadStatus;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly syncError: string | null;
  readonly historyLoading: boolean;
  /** Why the last history load failed, when it did. */
  readonly historyError: string | null;
  readonly hasMoreHistory: boolean;
  /** The last load through the message finished without changing the feed. */
  readonly lastLoadChangedNothing: boolean;
  readonly historyPagesRequested?: number;
}): "scroll" | "expand" | "expand-row" | "wait" | "load" | "missing" | "failed" {
  // A sync snapshot or history page can replace a cached row before scrolling.
  if (input.syncStatus === "deleted") return "missing";
  if (input.historyLoading) return "wait";
  if (
    input.syncStatus === "empty" ||
    input.syncStatus === "cached" ||
    input.syncStatus === "synchronizing"
  ) {
    // Empty and cached data also precede the connection's first sync attempt.
    return input.connectionPhase === "offline" ||
      input.connectionPhase === "error" ||
      input.connectionPhase === "unsupported" ||
      (input.connectionPhase === "connected" && input.syncError !== null)
      ? "failed"
      : "wait";
  }
  // An omitted status retains the standalone feed's previous ready default.
  if (input.synced === false) return "wait";
  if (input.foldedRowId !== null) return "expand-row";
  if (input.presented) return "scroll";
  if (input.foldedRunId !== null) return "expand";
  // Loaded but hidden by something other than a fold: more history cannot reveal it.
  if (input.inFeed) return "missing";
  if (input.historyError !== null) return "failed";
  if (!input.hasMoreHistory) return "missing";
  // Older history remains, so a load that returned nothing failed rather than ran out.
  return input.lastLoadChangedNothing || (input.historyPagesRequested ?? 0) >= 20
    ? "failed"
    : "load";
}
