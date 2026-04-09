import { createStore } from "zustand/vanilla";

import { reduceWorkspaceState } from "./reducer";
import { sameWorkspaceState, type WorkspaceState } from "./types";
import type { MainSurface, SecondarySurface, WorkspaceTarget } from "./types";

type WorkspaceOptimisticTransition = {
  baseState: WorkspaceState;
  nextState: WorkspaceState;
};

export interface WorkspaceNavigationOptions {
  replace?: boolean;
}

export type OpenSurfaceFn = {
  (placement: "main", surface: MainSurface, options?: WorkspaceNavigationOptions): void;
  (placement: "secondary", surface: SecondarySurface, options?: WorkspaceNavigationOptions): void;
};

export type UpdateSurfaceFn = {
  (placement: "main", input: MainSurface["input"], options?: WorkspaceNavigationOptions): void;
  (
    placement: "secondary",
    input: SecondarySurface["input"],
    options?: WorkspaceNavigationOptions,
  ): void;
};

interface WorkspaceStoreController {
  getRouteState: () => { target: WorkspaceTarget; resolvedState: WorkspaceState };
  navigateToState: (state: WorkspaceState, options?: WorkspaceNavigationOptions) => void;
}

export interface WorkspaceStoreState {
  routeState: WorkspaceState;
  optimisticTransition: WorkspaceOptimisticTransition | null;
}

export interface WorkspaceStore extends WorkspaceStoreState {
  setOptimisticState: (baseState: WorkspaceState, nextState: WorkspaceState) => void;
  syncRouteState: (routeState: WorkspaceState) => void;
  openSurface: OpenSurfaceFn;
  closeSurface: (placement: "secondary", options?: WorkspaceNavigationOptions) => void;
  updateSurface: UpdateSurfaceFn;
}

export type WorkspaceStoreApi = ReturnType<typeof createWorkspaceStore>;

export function selectResolvedWorkspaceState(state: WorkspaceStoreState): WorkspaceState {
  return state.optimisticTransition?.nextState ?? state.routeState;
}

export function createWorkspaceStore(
  initialState: WorkspaceState,
  controller: WorkspaceStoreController,
) {
  return createStore<WorkspaceStore>()((set, get) => ({
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
    openSurface: ((
      placement: "main" | "secondary",
      surface: MainSurface | SecondarySurface,
      options,
    ) => {
      const currentState = selectResolvedWorkspaceState(get());
      const nextState = reduceWorkspaceState(
        currentState,
        placement === "main"
          ? {
              type: "openSurface",
              placement,
              surface: surface as MainSurface,
            }
          : {
              type: "openSurface",
              placement,
              surface: surface as SecondarySurface,
            },
      );
      if (nextState === currentState) {
        return;
      }

      const latestRoute = controller.getRouteState();
      get().setOptimisticState(latestRoute.resolvedState, nextState);
      controller.navigateToState(nextState, options);
    }) as OpenSurfaceFn,
    closeSurface: (placement: "secondary", options?: WorkspaceNavigationOptions) => {
      const currentState = selectResolvedWorkspaceState(get());
      const nextState = reduceWorkspaceState(currentState, { type: "closeSurface", placement });
      if (nextState === currentState) {
        return;
      }

      const latestRoute = controller.getRouteState();
      get().setOptimisticState(latestRoute.resolvedState, nextState);
      controller.navigateToState(nextState, options);
    },
    updateSurface: ((
      placement: "main" | "secondary",
      input: MainSurface["input"] | SecondarySurface["input"],
      options,
    ) => {
      const currentState = selectResolvedWorkspaceState(get());
      const nextState = reduceWorkspaceState(
        currentState,
        placement === "main"
          ? {
              type: "updateSurface",
              placement,
              surfaceId: "chat",
              input: input as MainSurface["input"],
            }
          : {
              type: "updateSurface",
              placement,
              surfaceId: "diff",
              input: input as SecondarySurface["input"],
            },
      );
      if (nextState === currentState) {
        return;
      }

      const latestRoute = controller.getRouteState();
      get().setOptimisticState(latestRoute.resolvedState, nextState);
      controller.navigateToState(nextState, options);
    }) as UpdateSurfaceFn,
  }));
}
