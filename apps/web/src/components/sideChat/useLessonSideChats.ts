import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type AssistantCitation,
  type OrchestrationV2Run,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import {
  selectThreadRightPanelState,
  sideChatSurfaceTopThreadId,
  useRightPanelStore,
} from "../../rightPanelStore";
import { readThreadShell, useSideChatTreeShells } from "../../state/entities";
import { useEnvironmentShellStatus } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { isThreadRouteSnapshotAuthoritative } from "../../threadRoutes";
import { askInSideChat } from "./openSideChat";
import {
  pendingSideChatThreadIds,
  selectStartingSideChat,
  usePendingSideChatStore,
} from "./pendingSideChatStore";
import { revealSideChat } from "./sideChatNavigation";
import { lessonSideChatWaitLabel, sideChatAwaitingInput } from "./sideChatPanel.logic";

/**
 * The lesson's side chats as its chat view uses them: Ask from the lesson's replies,
 * tab labels, the note wait label, and tabs kept in step with the side chats that exist.
 */
export function useLessonSideChats(input: {
  /** Null for drafts and for a route that is itself a side chat. */
  readonly lessonRef: ScopedThreadRef | null;
  /** The environment handles T3 Learn side chats (`supportsLessonSideChats`). */
  readonly supported: boolean;
  /** The server config, which can arrive after the shells, has said whether `supported`. */
  readonly capabilityKnown: boolean;
  readonly activityRunStatus: OrchestrationV2Run["status"] | null;
}): {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly labelsById: ReadonlyMap<string, string>;
  readonly askPending: boolean;
  readonly noteWaitLabel: "Adding side-chat note…" | null;
  readonly onAskInSideChat:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
} {
  const { lessonRef, supported, capabilityKnown, activityRunStatus } = input;
  const shells = useSideChatTreeShells(supported ? lessonRef : null);
  const shellLive = isThreadRouteSnapshotAuthoritative(
    useEnvironmentShellStatus(lessonRef?.environmentId ?? null),
  );
  const run = useOrchestrationCommand(threadEnvironment.openSideChat, { reportFailure: false });
  const lessonKey = lessonRef === null ? null : scopedThreadKey(lessonRef);
  const askPending = usePendingSideChatStore((state) => selectStartingSideChat(state, lessonKey));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles the pending side-chat and right panel stores with the lesson's live shells
  useEffect(() => {
    // The shells cached from the last visit can predate side chats asked for just
    // before a reload, so only the live shell can say a side chat is gone.
    if (lessonRef === null || !capabilityKnown || !shellLive) return;
    const key = scopedThreadKey(lessonRef);
    const shellIds = new Set<string>(shells.map((shell) => shell.id));
    usePendingSideChatStore.getState().prune(key, shellIds);
    const live = new Set([
      ...shellIds,
      ...pendingSideChatThreadIds(usePendingSideChatStore.getState(), key),
    ]);
    // Without the capability no side chat is listed, though none is gone.
    if (supported) clearGoneSideChatDrafts(lessonRef, live);
    useRightPanelStore.getState().reconcileSideChatSurfaces(lessonRef, live, supported);
  }, [capabilityKnown, lessonRef, shellLive, shells, supported]);

  const awaitingId = sideChatAwaitingInput(shells);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the side chat panel in the right panel store when a side chat starts waiting for input
  useEffect(() => {
    if (lessonRef === null || awaitingId === null) return;
    revealSideChat(lessonRef, awaitingId, true);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Only a side chat that starts waiting opens, so one the user closed while it waits stays closed.
  }, [awaitingId]);

  const ask = useStableCallback((citation: AssistantCitation) => {
    if (lessonRef === null) return false;
    return askInSideChat({ lessonRef, citation, sideChatShells: shells, topThreadId: null, run });
  });

  return {
    shells,
    labelsById: new Map(
      shells.flatMap((shell) =>
        shell.sideChat == null ? [] : [[shell.id as string, shell.sideChat.label] as const],
      ),
    ),
    askPending,
    noteWaitLabel:
      lessonRef === null
        ? null
        : lessonSideChatWaitLabel({
            lessonThreadId: lessonRef.threadId,
            activityRunStatus,
            shells,
          }),
    onAskInSideChat: supported && lessonRef !== null ? ask : undefined,
  };
}

/** A deleted side chat's draft would otherwise stay in persisted storage with no tab to reach it. */
function clearGoneSideChatDrafts(lessonRef: ScopedThreadRef, live: ReadonlySet<string>) {
  const { surfaces } = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    lessonRef,
  );
  const drafts = useComposerDraftStore.getState();
  for (const surface of surfaces) {
    if (surface.kind !== "lesson-side-chat") continue;
    const shown = [sideChatSurfaceTopThreadId(surface), surface.threadId, ...(surface.trail ?? [])];
    for (const id of new Set(shown)) {
      if (live.has(id)) continue;
      const ref = scopeThreadRef(lessonRef.environmentId, ThreadId.make(id));
      // An archived side chat comes back when its lesson is unarchived, draft and all.
      if (readThreadShell(ref)?.deletedAt === null) continue;
      drafts.clearComposerContent(ref);
    }
  }
}
