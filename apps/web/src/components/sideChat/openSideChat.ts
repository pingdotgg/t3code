import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { OpenSideChatInput } from "@t3tools/client-runtime/operations";
import type {
  AssistantCitation,
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { newThreadId } from "../../lib/utils";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { usePendingSideChatStore } from "./pendingSideChatStore";
import { focusSideChat } from "./sideChatNavigation";
import { shouldFinishSideChatOnClose } from "./sideChatPanel.logic";
import { findOverlappingSideChat, sideChatAnchorFromCitation } from "./sideChatSelection";

export type OpenSideChatRunner = (value: {
  readonly environmentId: EnvironmentId;
  readonly input: OpenSideChatInput;
}) => Promise<AtomCommandResult<unknown, unknown>>;

export interface OpenSideChatFromSelectionInput {
  readonly lessonRef: ScopedThreadRef;
  readonly citation: AssistantCitation;
  /** The lesson's side chats, so a selection that overlaps a highlight reopens its side chat. */
  readonly sideChatShells: ReadonlyArray<EnvironmentThreadShell>;
  /** The top-level side chat whose tab holds the selection, or null for a selection in the lesson. */
  readonly topThreadId: string | null;
  readonly run: OpenSideChatRunner;
}

export type OpenSideChatOutcome =
  | { readonly _tag: "Reused"; readonly threadId: ThreadId }
  | { readonly _tag: "Opened"; readonly threadId: ThreadId }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Interrupted" };

/**
 * Opens a side chat on the selection. Its tab shows "Starting side chat…" before
 * the server answers, and goes away again if the server refuses.
 */
export async function openSideChatFromSelection(
  input: OpenSideChatFromSelectionInput,
): Promise<OpenSideChatOutcome> {
  const { lessonRef, citation, topThreadId } = input;
  const existingId = findOverlappingSideChat(input.sideChatShells, citation);
  if (existingId !== null) {
    focusSideChat(lessonRef, existingId);
    return { _tag: "Reused", threadId: existingId };
  }

  const threadId = newThreadId();
  const sideChatRef = scopeThreadRef(lessonRef.environmentId, threadId);
  const pendingKey = scopedThreadKey(sideChatRef);
  usePendingSideChatStore.getState().begin(pendingKey, {
    threadId,
    lessonThreadKey: scopedThreadKey(lessonRef),
    citation,
    status: "starting",
  });
  usePendingSideChatStore.getState().requestFocus(pendingKey);
  const panels = useRightPanelStore.getState();
  panels.openLessonSideChat(lessonRef, { topThreadId: topThreadId ?? threadId, threadId });
  panels.setMaximized(lessonRef, false);

  const result = await input.run({
    environmentId: lessonRef.environmentId,
    input: {
      threadId,
      anchorThreadId: citation.threadId,
      anchor: sideChatAnchorFromCitation(citation),
      excerpt: citation.text,
    },
  });

  if (result._tag === "Failure") {
    usePendingSideChatStore.getState().remove(pendingKey);
    useRightPanelStore
      .getState()
      .closeFailedSideChat(lessonRef, threadId, topThreadId === null ? null : citation.threadId);
    releaseComposerDraftUploads(sideChatRef);
    useComposerDraftStore.getState().clearDraftThread(sideChatRef);
    if (isAtomCommandInterrupted(result)) return { _tag: "Interrupted" };
    const error = squashAtomCommandFailure(result);
    return {
      _tag: "Failed",
      message: error instanceof Error ? error.message : "The side chat could not start.",
    };
  }

  if (wasClosedUnused(lessonRef, sideChatRef)) {
    // Closing its tab while it started could not finish it yet, so finish it now
    // and the server throws the empty side chat away.
    usePendingSideChatStore.getState().remove(pendingKey);
    const finished = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.finishSideChat,
      { environmentId: lessonRef.environmentId, input: { threadId } },
      { reportFailure: false },
    );
    // Nothing can reach the deleted side chat's draft again.
    if (finished._tag === "Success") {
      releaseComposerDraftUploads(sideChatRef);
      useComposerDraftStore.getState().clearDraftThread(sideChatRef);
    }
  } else {
    usePendingSideChatStore.getState().markStarted(pendingKey);
  }
  return { _tag: "Opened", threadId };
}

/** No tab shows the side chat any more, and nothing was sent to it. */
function wasClosedUnused(lessonRef: ScopedThreadRef, sideChatRef: ScopedThreadRef): boolean {
  const shown = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    lessonRef,
  ).surfaces.some(
    (surface) => surface.kind === "lesson-side-chat" && surface.threadId === sideChatRef.threadId,
  );
  if (shown) return false;
  const shell = readThreadShell(sideChatRef);
  return shell === null || shouldFinishSideChatOnClose(shell);
}

/** Starts the open without waiting for it; a refusal shows as a toast. */
export function askInSideChat(input: OpenSideChatFromSelectionInput): boolean {
  void openSideChatFromSelection(input).then((outcome) => {
    if (outcome._tag !== "Failed") return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn't start the side chat",
        description: outcome.message,
      }),
    );
  });
  return true;
}
