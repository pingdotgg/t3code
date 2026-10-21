import { filterPendingNewTasksBySpace } from "./pending-new-tasks-model";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_SPACES_STATE, type SpacesState } from "@t3tools/contracts";
import { filterSpaceEntities } from "@t3tools/client-runtime/state/spaces";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { PendingNewTask } from "./use-pending-new-tasks";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";

export function useMobileSpaces() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const state = AsyncResult.isSuccess(preferences)
    ? (preferences.value.spaces ?? DEFAULT_SPACES_STATE)
    : DEFAULT_SPACES_STATE;
  const update = useCallback(
    (transform: (state: SpacesState) => SpacesState) => {
      save({
        transform: (current) => ({ spaces: transform(current.spaces ?? DEFAULT_SPACES_STATE) }),
      });
    },
    [save],
  );
  return { state, update, ready: AsyncResult.isSuccess(preferences) };
}

export function useSpaceEntities(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) {
  const { state } = useMobileSpaces();
  return useMemo(() => filterSpaceEntities(state, projects, threads), [state, projects, threads]);
}

export function useSpacePendingTasks(tasks: ReadonlyArray<PendingNewTask>) {
  const { state } = useMobileSpaces();
  return useMemo(() => filterPendingNewTasksBySpace(state, tasks), [state, tasks]);
}
