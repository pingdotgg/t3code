import type { ScopedProjectRef } from "@t3tools/contracts";
import { flushSync } from "react-dom";

import { type DraftId, type DraftSessionState, useComposerDraftStore } from "../composerDraftStore";

type DraftWorkspaceDefault = Pick<DraftSessionState, "envMode" | "startFromOrigin">;

interface PendingWorkspaceDefault {
  readonly projectRef: ScopedProjectRef;
  readonly workspace: DraftWorkspaceDefault;
  readonly openedManual: boolean;
  readonly settled: Promise<void>;
  // Resolved when a later move replaces this default, so a send waiting on it stops.
  readonly superseded: PromiseWithResolvers<false>;
  readonly branchActions: Set<Promise<void>>;
  branchChosen: boolean;
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
    !pending.branchChosen &&
    draft.worktreePath === null &&
    (pending.openedManual || draft.environmentSelection !== "manual")
  );
}

/** Resolves false when the draft moves before its default lands, so a waiting send stops. */
export function readPendingWorkspaceDefault(draftId: DraftId): Promise<boolean> | null {
  const pending = pendingDefaults.get(draftId);
  if (!pending) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  if (!acceptsWorkspaceDefault(draft, pending)) return null;
  return Promise.race([pending.settled.then(() => true), pending.superseded.promise]);
}

/** Hold a pending default until a manual branch action commits or finishes without a choice. */
export async function withDraftBranchChoice(
  draftId: DraftId | null,
  action: (commit: () => void) => Promise<void>,
): Promise<void> {
  const pending = draftId === null ? undefined : pendingDefaults.get(draftId);
  if (!pending) return action(() => {});
  const hold = Promise.withResolvers<void>();
  pending.branchActions.add(hold.promise);
  try {
    await action(() => {
      pending.branchChosen = true;
    });
  } finally {
    pending.branchActions.delete(hold.promise);
    hold.resolve();
  }
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
    .then(async (resolved) => {
      while (pendingDefaults.get(draftId) === pending && pending.branchActions.size > 0) {
        await Promise.all(pending.branchActions);
      }
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
  const pending: PendingWorkspaceDefault = {
    projectRef,
    workspace,
    openedManual: getDraftSession(draftId)?.environmentSelection === "manual",
    settled,
    superseded: Promise.withResolvers<false>(),
    branchActions: new Set(),
    branchChosen: false,
  };
  pendingDefaults.get(draftId)?.superseded.resolve(false);
  pendingDefaults.set(draftId, pending);
}
