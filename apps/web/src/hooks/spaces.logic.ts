import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { SpacesState } from "@t3tools/contracts/settings";
import {
  isThreadInSpace,
  assignThreadSpace,
  assignNewThreadSpace,
  resolveThreadSpace,
} from "@t3tools/client-runtime/state/spaces";

/** A stale remembered thread must never open in a different Space. */
export function resolveSpaceThread(
  state: SpacesState,
  threads: ReadonlyArray<{
    environmentId: EnvironmentId;
    id: ThreadId;
    projectId: ProjectId;
    archivedAt?: string | null;
  }>,
): ScopedThreadRef | null {
  const ref = state.lastThreadBySpace[state.activeSpaceId ?? "all"];
  if (!ref) return null;
  const thread = threads.find(
    (entry) => entry.environmentId === ref.environmentId && entry.id === ref.threadId,
  );
  return thread && !thread.archivedAt && isThreadInSpace(state, thread) ? ref : null;
}

export function transferDraftSpace(
  state: SpacesState,
  previous: ScopedThreadRef & { readonly projectId: ProjectId },
  next: ScopedThreadRef & { readonly projectId: ProjectId },
): SpacesState {
  const previousRef = scopeThreadRef(previous.environmentId, previous.threadId);
  const nextRef = scopeThreadRef(next.environmentId, next.threadId);
  const key = scopedThreadKey(previousRef);
  if (Object.hasOwn(state.threadSpaces, key)) {
    const updated = assignThreadSpace(state, nextRef, state.threadSpaces[key]);
    return scopedThreadKey(previousRef) === scopedThreadKey(nextRef)
      ? updated
      : assignThreadSpace(updated, previousRef, undefined);
  }
  const membership = resolveThreadSpace(state, {
    environmentId: previous.environmentId,
    id: previous.threadId,
    projectId: previous.projectId,
  });
  return state.activeSpaceId !== null && membership === state.activeSpaceId
    ? assignNewThreadSpace(
        state,
        { environmentId: next.environmentId, id: next.threadId, projectId: next.projectId },
        membership,
      )
    : state;
}
