import { useState } from "react";

export interface WorkspaceRevisionState {
  readonly scope: string;
  /** The last loaded mutation id seen for each scope. */
  readonly seen: ReadonlyMap<string, string | null>;
  readonly revision: string | null;
}

/**
 * `mutationId` is `undefined` while the scope's history is still loading. Switching to a scope or
 * loading its history is not a workspace change, but any mutation id not yet seen for the scope may
 * be, even a never-viewed scope's first one. Only unchanged ids and a first `null` are absorbed.
 */
export function advanceWorkspaceRevision(
  state: WorkspaceRevisionState,
  scope: string,
  mutationId: string | null | undefined,
): WorkspaceRevisionState {
  const next = state.scope === scope ? state : { ...state, scope };
  if (mutationId === undefined) return next;
  const known = next.seen.has(scope);
  if (known && next.seen.get(scope) === mutationId) return next;
  const seen = new Map(next.seen).set(scope, mutationId);
  return { scope, seen, revision: known || mutationId !== null ? mutationId : next.revision };
}

/** A workspace mutation revision that survives switching between threads of one workspace. */
export function useWorkspaceRevision(
  scope: string,
  mutationId: string | null | undefined,
): string | null {
  const [state, setState] = useState<WorkspaceRevisionState>(() => ({
    scope,
    seen: new Map(mutationId === undefined ? [] : [[scope, mutationId]]),
    revision: mutationId ?? null,
  }));
  const next = advanceWorkspaceRevision(state, scope, mutationId);
  // Adjusted during render so readers never see the previous thread's revision change.
  if (next !== state) setState(next);
  return next.revision;
}
