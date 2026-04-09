import { createStore } from "zustand/vanilla";

import { sameWorkspaceState, type WorkspaceState } from "./types";

type WorkspaceOptimisticTransition = {
  baseState: WorkspaceState;
  nextState: WorkspaceState;
};

export interface WorkspaceStoreState {
  routeState: WorkspaceState;
  optimisticTransition: WorkspaceOptimisticTransition | null;
}

export interface WorkspaceStore extends WorkspaceStoreState {
  setOptimisticState: (baseState: WorkspaceState, nextState: WorkspaceState) => void;
  syncRouteState: (routeState: WorkspaceState) => void;
}

export type WorkspaceStoreApi = ReturnType<typeof createWorkspaceStore>;

export function selectResolvedWorkspaceState(state: WorkspaceStoreState): WorkspaceState {
  return state.optimisticTransition?.nextState ?? state.routeState;
}

export function createWorkspaceStore(initialState: WorkspaceState) {
  return createStore<WorkspaceStore>()((set) => ({
    routeState: initialState,
    optimisticTransition: null,
    setOptimisticState: (baseState, nextState) =>
      set((current) => {
        if (
          current.optimisticTransition &&
          sameWorkspaceState(current.optimisticTransition.baseState, baseState) &&
          sameWorkspaceState(current.optimisticTransition.nextState, nextState)
        ) {
          return current;
        }

        return {
          optimisticTransition: {
            baseState,
            nextState,
          },
        };
      }),
    syncRouteState: (routeState) =>
      set((current) => {
        if (sameWorkspaceState(current.routeState, routeState)) {
          if (
            current.optimisticTransition === null ||
            sameWorkspaceState(routeState, current.optimisticTransition.baseState)
          ) {
            return current;
          }
        }

        if (
          current.optimisticTransition &&
          sameWorkspaceState(routeState, current.optimisticTransition.baseState)
        ) {
          return {
            routeState,
          };
        }

        return {
          routeState,
          optimisticTransition: null,
        };
      }),
  }));
}
