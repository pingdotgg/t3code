import type { ScopedProjectRef } from "@t3tools/contracts";
import { flushSync } from "react-dom";

import { type DraftId, type DraftSessionState, useComposerDraftStore } from "../composerDraftStore";

type DraftWorkspaceDefault = Pick<DraftSessionState, "envMode" | "startFromOrigin">;

interface PendingWorkspaceDefault {
  readonly projectRef: ScopedProjectRef;
  readonly workspace: DraftWorkspaceDefault;
  readonly openedManual: boolean;
  readonly settled: Promise<void>;
}

const pendingDefaults = new Map<DraftId, PendingWorkspaceDefault>();

function acceptsWorkspaceDefault(
  draft: DraftSessionState | null,
  pending: PendingWorkspaceDefault,
): draft is DraftSessionState {
  return (
    draft !== null &&
    draft.promotedTo == null &&
    draft.environmentId === pending.projectRef.environmentId &&
    draft.projectId === pending.projectRef.projectId &&
    draft.envMode === pending.workspace.envMode &&
    !draft.workspaceExplicit &&
    draft.worktreePath === null &&
    (pending.openedManual || draft.environmentSelection !== "manual")
  );
}

const pendingCheckouts = new Map<DraftId, Promise<void>>();

/** A send waits while a checkout is prepared for its draft, so it starts in that checkout. */
export function trackPendingDraftCheckout(draftId: DraftId, checkout: Promise<unknown>) {
  const settled: Promise<void> = checkout
    .then(
      () => {},
      () => {},
    )
    .finally(() => {
      if (pendingCheckouts.get(draftId) === settled) pendingCheckouts.delete(draftId);
    });
  pendingCheckouts.set(draftId, settled);
}

export function readPendingWorkspaceDefault(draftId: DraftId): Promise<void> | null {
  const checkout = pendingCheckouts.get(draftId);
  if (checkout) return checkout;
  const pending = pendingDefaults.get(draftId);
  if (!pending) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  return acceptsWorkspaceDefault(draft, pending) ? pending.settled : null;
}

/** A visible draft can use a provisional workspace while its project file loads. */
export function trackPendingWorkspaceDefault(
  draftId: DraftId,
  projectRef: ScopedProjectRef,
  workspace: DraftWorkspaceDefault,
  resolution: Promise<DraftWorkspaceDefault>,
) {
  const { getDraftSession, setDraftThreadContext } = useComposerDraftStore.getState();
  const settled = resolution
    .then((resolved) => {
      const draft = getDraftSession(draftId);
      if (pendingDefaults.get(draftId) !== pending || !acceptsWorkspaceDefault(draft, pending))
        return;
      if (
        resolved.envMode === workspace.envMode &&
        resolved.startFromOrigin === workspace.startFromOrigin
      )
        return;
      // A send waiting on this promise must see the resolved workspace when it resumes.
      flushSync(() =>
        setDraftThreadContext(draftId, {
          envMode: resolved.envMode,
          ...(draft.startFromOrigin === workspace.startFromOrigin
            ? { startFromOrigin: resolved.startFromOrigin }
            : {}),
        }),
      );
    })
    .finally(() => {
      if (pendingDefaults.get(draftId) === pending) pendingDefaults.delete(draftId);
    });
  const pending = {
    projectRef,
    workspace,
    openedManual: getDraftSession(draftId)?.environmentSelection === "manual",
    settled,
  };
  pendingDefaults.set(draftId, pending);
}
