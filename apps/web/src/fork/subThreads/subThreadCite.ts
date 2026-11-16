import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ScopedThreadRef } from "@t3tools/contracts";
import type { RefObject } from "react";
import { flushSync } from "react-dom";

import type { ChatComposerHandle } from "../../components/chat/ChatComposer";
import { toastManager } from "../../components/ui/toast";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import type { CiteAssistantText } from "../dashboard/dashboardCitation";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";
import { openSubThread, type SubThreadSummary, useSubThreadSummaries } from "./subThreadsState";

type CiteComposer = RefObject<Pick<
  ChatComposerHandle,
  "readSnapshot" | "citeAssistantText"
> | null>;

interface ReplyBox {
  readonly first: string;
  readonly composer: CiteComposer;
}

// Set while a Cite opens the Replies sheet; the sheet's next initial focus takes it.
let sheetLeavesFocusToCite = false;
const replyBoxByThreadKey = new Map<string, ReplyBox>();

export function registerReplyBox(
  threadKey: string,
  first: string,
  composer: CiteComposer,
): () => void {
  const box = { first, composer };
  replyBoxByThreadKey.set(threadKey, box);
  return () => {
    if (replyBoxByThreadKey.get(threadKey) === box) replyBoxByThreadKey.delete(threadKey);
  };
}

const hasText = (composer: CiteComposer) =>
  (composer.current?.readSnapshot().value ?? "").trim() !== "";

function citeInto(
  composer: CiteComposer,
  citation: AssistantCitation,
  sourceAnchor: AssistantCitationSourceAnchor,
): boolean {
  const inserted = composer.current?.citeAssistantText(citation, sourceAnchor) ?? false;
  if (!inserted) {
    toastManager.add({
      type: "warning",
      title: "The composer is not ready",
      description: "Try citing the selection after the connection or pending input is resolved.",
    });
  }
  return inserted;
}

/**
 * Opens as the user's own panel choice, so a waiting automatic Diff cannot replace it, and with no
 * focus request, so focus stays with the quote's comment box.
 */
function openReplyBoxBesideMainList(threadRef: ScopedThreadRef, first: string): void {
  const panel = useRightPanelStore.getState();
  panel.markUserAction(threadRef);
  panel.setMaximized(threadRef, false);
  openSubThread(threadRef, first, true);
}

export function citeInThread(
  threadRef: ScopedThreadRef,
  cited: string,
  own: CiteComposer,
  citation: AssistantCitation,
  sourceAnchor: AssistantCitationSourceAnchor,
): boolean {
  if (hasText(own)) return citeInto(own, citation, sourceAnchor);
  const threadKey = scopedThreadKey(threadRef);
  const repliesOnScreen =
    selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "replies";
  const shown = repliesOnScreen ? replyBoxByThreadKey.get(threadKey) : undefined;
  if (shown && hasText(shown.composer)) return citeInto(shown.composer, citation, sourceAnchor);
  if (shown?.first !== cited) {
    sheetLeavesFocusToCite = window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches;
    // A sync commit runs its passive effects before returning, so the box has loaded its draft.
    flushSync(() => openReplyBoxBesideMainList(threadRef, cited));
  }
  const box = replyBoxByThreadKey.get(threadKey);
  if (box?.first !== cited) {
    sheetLeavesFocusToCite = false;
    toastManager.add({ type: "warning", title: "Could not open the reply box" });
    return false;
  }
  const inserted = citeInto(box.composer, citation, sourceAnchor);
  if (!inserted) sheetLeavesFocusToCite = false;
  return inserted;
}

/** A main-list Cite goes to a message's Replies only once it has replies; else it stays in the main box. */
export const citeOpensReplies = (summary: SubThreadSummary | undefined): boolean =>
  (summary?.replies ?? 0) > 0;

export function useSubThreadCite(
  routingThreadRef: ScopedThreadRef | null,
  composer: CiteComposer,
): CiteAssistantText {
  const routes = useThreadDisplayMode(routingThreadRef).subThreads;
  const summaries = useSubThreadSummaries(routes ? routingThreadRef : null);
  return useStableCallback((citation, sourceAnchor) =>
    routingThreadRef !== null && citeOpensReplies(summaries.get(citation.messageId))
      ? citeInThread(routingThreadRef, citation.messageId, composer, citation, sourceAnchor)
      : citeInto(composer, citation, sourceAnchor),
  );
}

/**
 * The right panel sheet's initial focus. When a Cite opened the sheet, focus is left to the
 * quote's comment box; otherwise the sheet focuses as usual.
 */
export function sheetInitialFocus(): boolean {
  const leave = sheetLeavesFocusToCite;
  sheetLeavesFocusToCite = false;
  return !leave;
}
