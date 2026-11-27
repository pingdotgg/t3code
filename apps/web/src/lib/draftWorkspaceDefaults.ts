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

function isInProject(
  draft: DraftSessionState | null,
  projectRef: ScopedProjectRef,
): draft is DraftSessionState {
  return (
    draft !== null &&
    draft.promotedTo == null &&
    draft.environmentId === projectRef.environmentId &&
    draft.projectId === projectRef.projectId
  );
}

function acceptsWorkspaceDefault(
  draft: DraftSessionState | null,
  pending: PendingWorkspaceDefault,
): draft is DraftSessionState {
  return (
    isInProject(draft, pending.projectRef) &&
    draft.envMode === pending.workspace.envMode &&
    !draft.workspaceExplicit &&
    draft.worktreePath === null &&
    (pending.openedManual || draft.environmentSelection !== "manual")
  );
}

type CheckoutOutcome = boolean | "moved";

const pendingCheckouts = new Map<DraftId, Promise<CheckoutOutcome>>();

/**
 * A waiting send can resume only after the current checkout has been applied. Moving the draft
 * to another project drops the checkout, even if the draft moves back before it finishes.
 */
export function trackPendingDraftCheckout(
  draftId: DraftId,
  projectRef: ScopedProjectRef,
  checkoutReady: Promise<boolean>,
) {
  const { promise: settled, resolve } = Promise.withResolvers<CheckoutOutcome>();
  const isCurrent = () => pendingCheckouts.get(draftId) === settled;
  const release = (outcome: CheckoutOutcome) => {
    unsubscribe();
    if (isCurrent()) pendingCheckouts.delete(draftId);
    resolve(outcome);
  };
  const unsubscribe = useComposerDraftStore.subscribe((state) => {
    if (!isInProject(state.getDraftSession(draftId), projectRef)) release("moved");
  });
  pendingCheckouts.set(draftId, settled);
  checkoutReady.then(release, () => release(false));
  return isCurrent;
}

/** "moved" means the send waited on a checkout the draft left by changing projects. */
export function readPendingWorkspaceDefault(
  draftId: DraftId,
): Promise<CheckoutOutcome | void> | null {
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
