import type {
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import type { Space, SpacesState } from "@t3tools/contracts/settings";

import { scopedProjectKey, scopedThreadKey } from "../environment/scoped.ts";

type SpaceProject = { readonly environmentId: EnvironmentId; readonly id: ProjectId };
type SpaceThread = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
};

export function resolveProjectSpace(state: SpacesState, project: ScopedProjectRef): string | null {
  return state.projectSpaces[scopedProjectKey(project)] ?? null;
}

export function resolveThreadSpace(state: SpacesState, thread: SpaceThread): string | null {
  const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
  if (Object.hasOwn(state.threadSpaces, key)) {
    return state.threadSpaces[key] ?? null;
  }
  return resolveProjectSpace(state, thread);
}

export function isThreadInSpace(state: SpacesState, thread: SpaceThread): boolean {
  return state.activeSpaceId === null || resolveThreadSpace(state, thread) === state.activeSpaceId;
}

/** Keep parent project shells so independently assigned threads remain reachable. */
export function filterSpaceEntities<P extends SpaceProject, T extends SpaceThread>(
  state: SpacesState,
  projects: ReadonlyArray<P>,
  threads: ReadonlyArray<T>,
): { projects: ReadonlyArray<P>; threads: ReadonlyArray<T> } {
  if (state.activeSpaceId === null) {
    return { projects, threads };
  }
  const visibleThreads = threads.filter((thread) => isThreadInSpace(state, thread));
  const parentKeys = new Set(visibleThreads.map((thread) => scopedProjectKey(thread)));
  return {
    projects: projects.filter(
      (project) =>
        resolveProjectSpace(state, {
          environmentId: project.environmentId,
          projectId: project.id,
        }) === state.activeSpaceId ||
        parentKeys.has(
          scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
        ),
    ),
    threads: visibleThreads,
  };
}

export function assignProjectSpace(
  state: SpacesState,
  project: ScopedProjectRef,
  spaceId: string | null,
): SpacesState {
  const projectSpaces = { ...state.projectSpaces };
  const key = scopedProjectKey(project);
  if (spaceId === null || !state.spaces.some((space) => space.id === spaceId)) {
    delete projectSpaces[key];
  } else {
    projectSpaces[key] = spaceId;
  }
  return { ...state, projectSpaces };
}

export function assignThreadSpace(
  state: SpacesState,
  thread: ScopedThreadRef,
  spaceId: string | null | undefined,
): SpacesState {
  const threadSpaces = { ...state.threadSpaces };
  const key = scopedThreadKey(thread);
  if (spaceId === undefined) {
    delete threadSpaces[key];
  } else {
    // Creation can finish after its captured Space has been deleted.
    threadSpaces[key] = state.spaces.some((space) => space.id === spaceId) ? spaceId : null;
  }
  return { ...state, threadSpaces };
}

export function assignNewThreadSpace(
  state: SpacesState,
  thread: SpaceThread,
  spaceId: string | null,
): SpacesState {
  return assignThreadSpace(
    state,
    { environmentId: thread.environmentId, threadId: thread.id },
    spaceId === null || resolveProjectSpace(state, thread) === spaceId ? undefined : spaceId,
  );
}

export function createSpace(state: SpacesState, space: Space): SpacesState {
  const name = space.name.trim();
  if (!name || state.spaces.some((existing) => existing.id === space.id)) {
    return state;
  }
  return { ...state, spaces: [...state.spaces, { ...space, name }] };
}

export function updateSpace(
  state: SpacesState,
  spaceId: string,
  patch: Partial<Pick<Space, "name" | "theme">>,
): SpacesState {
  if (patch.name !== undefined && !patch.name.trim()) {
    return state;
  }
  return {
    ...state,
    spaces: state.spaces.map((space) =>
      space.id === spaceId ? { ...space, ...patch, name: patch.name?.trim() ?? space.name } : space,
    ),
  };
}

/** Removing an override leaves No Space, rather than moving it into its parent's Space. */
export function removeSpace(state: SpacesState, spaceId: string): SpacesState {
  const lastThreadBySpace = { ...state.lastThreadBySpace };
  delete lastThreadBySpace[spaceId];
  return {
    ...state,
    spaces: state.spaces.filter((space) => space.id !== spaceId),
    activeSpaceId: state.activeSpaceId === spaceId ? null : state.activeSpaceId,
    projectSpaces: Object.fromEntries(
      Object.entries(state.projectSpaces).filter(([, membership]) => membership !== spaceId),
    ),
    threadSpaces: Object.fromEntries(
      Object.entries(state.threadSpaces).map(([key, membership]) => [
        key,
        membership === spaceId ? null : membership,
      ]),
    ),
    lastThreadBySpace,
  };
}

export function selectSpace(state: SpacesState, spaceId: string | null): SpacesState {
  return {
    ...state,
    activeSpaceId: state.spaces.some((space) => space.id === spaceId) ? spaceId : null,
  };
}

export function cycleSpace(state: SpacesState, direction: 1 | -1): SpacesState {
  if (state.spaces.length === 0) {
    return state;
  }
  const spaceIds = [null, ...state.spaces.map((space) => space.id)];
  const index = Math.max(0, spaceIds.indexOf(state.activeSpaceId));
  return selectSpace(
    state,
    spaceIds[(index + direction + spaceIds.length) % spaceIds.length] ?? null,
  );
}

export function spaceIdForIndex(state: SpacesState, index: number): string | undefined {
  return state.spaces[index - 1]?.id;
}

export function rememberSpaceThread(state: SpacesState, thread: ScopedThreadRef): SpacesState {
  return {
    ...state,
    lastThreadBySpace: { ...state.lastThreadBySpace, [state.activeSpaceId ?? "all"]: thread },
  };
}
