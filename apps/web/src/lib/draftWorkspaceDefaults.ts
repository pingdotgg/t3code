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

interface PendingDraftCheckout {
  readonly settled: Promise<void | false>;
  readonly invalidate: () => void;
}

const pendingCheckouts = new Map<DraftId, PendingDraftCheckout>();

/** A checkout can point its draft and delay sends only while the draft stays in its project. */
export function trackPendingDraftCheckout<T>(
  draftId: DraftId,
  projectRef: ScopedProjectRef,
  checkout: Promise<T>,
  apply: (result: T) => boolean,
): Promise<{ prepared: T; applied: boolean }> {
  const { getDraftSession } = useComposerDraftStore.getState();
  const staysInProject = () => isInProject(getDraftSession(draftId), projectRef);
  if (!staysInProject()) return checkout.then((prepared) => ({ prepared, applied: false }));

  const { promise: settled, resolve } = Promise.withResolvers<void | false>();
  const finish = (status: void | false) => {
    unsubscribe();
    if (pendingCheckouts.get(draftId) === pending) pendingCheckouts.delete(draftId);
    resolve(status);
  };
  const pending = { settled, invalidate: () => finish(false) };
  // Moving away invalidates the checkout even if the draft moves back before it finishes.
  const unsubscribe = useComposerDraftStore.subscribe(() => {
    if (!staysInProject()) pending.invalidate();
  });
  pendingCheckouts.get(draftId)?.invalidate();
  pendingCheckouts.set(draftId, pending);
  const pointed = checkout.then((prepared) => ({
    prepared,
    applied: pendingCheckouts.get(draftId) === pending && apply(prepared),
  }));
  void pointed.then(
    () => finish(undefined),
    () => finish(undefined),
  );
  return pointed;
}

/** A false result means the send was waiting on a checkout that no longer owns this draft. */
export function readPendingWorkspaceDefault(draftId: DraftId): Promise<void | false> | null {
  const checkout = pendingCheckouts.get(draftId);
  if (checkout) return checkout.settled;
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
