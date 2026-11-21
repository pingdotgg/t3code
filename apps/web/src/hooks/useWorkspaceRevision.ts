import { useState } from "react";

export interface WorkspaceRevisionState {
  readonly scope: string;
  /** The scope's mutation id the revision is measured from; `undefined` until it has loaded. */
  readonly baseline: string | null | undefined;
  readonly revision: string | null;
}

/**
 * `mutationId` is `undefined` while the scope's history is still loading. Switching scope or
 * loading its history is not a workspace change, so only a change after that bumps the revision.
 */
export function advanceWorkspaceRevision(
  state: WorkspaceRevisionState,
  scope: string,
  mutationId: string | null | undefined,
): WorkspaceRevisionState {
  if (state.scope !== scope) return { scope, baseline: mutationId, revision: state.revision };
  if (mutationId === undefined || mutationId === state.baseline) return state;
  if (state.baseline === undefined) return { ...state, baseline: mutationId };
  return { scope, baseline: mutationId, revision: mutationId };
}

/** A workspace mutation revision that survives switching between threads of one workspace. */
export function useWorkspaceRevision(
  scope: string,
  mutationId: string | null | undefined,
): string | null {
  const [state, setState] = useState<WorkspaceRevisionState>(() => ({
    scope,
    baseline: mutationId,
    revision: mutationId ?? null,
  }));
  const next = advanceWorkspaceRevision(state, scope, mutationId);
  // Adjusted during render so readers never see the previous thread's revision change.
  if (next !== state) setState(next);
  return next.revision;
}
