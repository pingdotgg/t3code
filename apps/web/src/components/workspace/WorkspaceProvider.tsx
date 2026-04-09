import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useStore as useZustandStore } from "zustand";

import { parseDiffRouteSearch } from "~/diffRouteSearch";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "~/threadRoutes";
import { reduceWorkspaceState, type WorkspaceAction } from "~/workspace/reducer";
import {
  createWorkspaceStore,
  type WorkspaceStore,
  type WorkspaceStoreApi,
} from "~/workspace/store";
import { buildWorkspaceRouteSearch, resolveWorkspaceState } from "~/workspace/urlState";
import type {
  MainSurface,
  SecondarySurface,
  WorkspaceState,
  WorkspaceTarget,
} from "~/workspace/types";

interface WorkspaceNavigationOptions {
  replace?: boolean;
}

type OpenSurfaceFn = {
  (placement: "main", surface: MainSurface, options?: WorkspaceNavigationOptions): void;
  (placement: "secondary", surface: SecondarySurface, options?: WorkspaceNavigationOptions): void;
};

type UpdateSurfaceFn = {
  (placement: "main", input: MainSurface["input"], options?: WorkspaceNavigationOptions): void;
  (
    placement: "secondary",
    input: SecondarySurface["input"],
    options?: WorkspaceNavigationOptions,
  ): void;
};

interface WorkspaceActionsContextValue {
  openSurface: OpenSurfaceFn;
  closeSurface: (placement: "secondary", options?: WorkspaceNavigationOptions) => void;
  updateSurface: UpdateSurfaceFn;
}

const WorkspaceStoreContext = createContext<WorkspaceStoreApi | null>(null);
const WorkspaceActionsContext = createContext<WorkspaceActionsContextValue | null>(null);

export function WorkspaceProvider(props: { target: WorkspaceTarget; children: ReactNode }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false, select: (value) => parseDiffRouteSearch(value) });
  const resolvedState = useMemo(
    () => resolveWorkspaceState(props.target, search),
    [props.target, search],
  );
  const storeRef = useRef<WorkspaceStoreApi | null>(null);
  if (!storeRef.current) {
    storeRef.current = createWorkspaceStore(resolvedState);
  }

  const store = storeRef.current;
  const latestRouteRef = useRef<{
    target: WorkspaceTarget;
    resolvedState: WorkspaceState;
  }>({
    target: props.target,
    resolvedState,
  });
  latestRouteRef.current = {
    target: props.target,
    resolvedState,
  };

  useEffect(() => {
    store.getState().syncRouteState(resolvedState);
  }, [resolvedState, store]);

  const dispatch = useCallback(
    (action: WorkspaceAction, options?: WorkspaceNavigationOptions) => {
      const currentStoreState = store.getState();
      const nextState = reduceWorkspaceState(currentStoreState.state, action);
      if (nextState === currentStoreState.state) {
        return;
      }

      const latestRoute = latestRouteRef.current;
      currentStoreState.setOptimisticState(latestRoute.resolvedState, nextState);

      if (latestRoute.target.kind === "server") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(latestRoute.target.threadRef),
          replace: options?.replace ?? false,
          search: (previous) => buildWorkspaceRouteSearch(nextState, previous),
        });
        return;
      }

      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(latestRoute.target.draftId),
        replace: options?.replace ?? false,
        search: (previous) => buildWorkspaceRouteSearch(nextState, previous),
      });
    },
    [navigate, store],
  );

  const openSurface = useCallback(
    ((placement: "main" | "secondary", surface: MainSurface | SecondarySurface, options) => {
      dispatch(
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
        options,
      );
    }) as OpenSurfaceFn,
    [dispatch],
  );

  const closeSurface = useCallback(
    (placement: "secondary", options?: WorkspaceNavigationOptions) => {
      dispatch({ type: "closeSurface", placement }, options);
    },
    [dispatch],
  );

  const updateSurface = useCallback(
    ((
      placement: "main" | "secondary",
      input: MainSurface["input"] | SecondarySurface["input"],
      options,
    ) => {
      dispatch(
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
        options,
      );
    }) as UpdateSurfaceFn,
    [dispatch],
  );

  const actions = useMemo<WorkspaceActionsContextValue>(
    () => ({
      openSurface,
      closeSurface,
      updateSurface,
    }),
    [closeSurface, openSurface, updateSurface],
  );

  return (
    <WorkspaceStoreContext.Provider value={store}>
      <WorkspaceActionsContext.Provider value={actions}>
        {props.children}
      </WorkspaceActionsContext.Provider>
    </WorkspaceStoreContext.Provider>
  );
}

function useWorkspaceStoreApiInternal(): WorkspaceStoreApi {
  const context = useContext(WorkspaceStoreContext);
  if (!context) {
    throw new Error("Workspace hooks must be used within a WorkspaceProvider.");
  }
  return context;
}

export function useWorkspaceStoreApi(): WorkspaceStoreApi {
  return useWorkspaceStoreApiInternal();
}

export function useWorkspaceStore<T>(selector: (state: WorkspaceStore) => T): T {
  const store = useWorkspaceStoreApiInternal();
  return useZustandStore(store, selector);
}

export function useWorkspaceState(): WorkspaceState {
  return useWorkspaceStore((state) => state.state);
}

export function useWorkspaceSecondarySurface(): SecondarySurface | null {
  return useWorkspaceStore((state) => state.state.surfaces.secondary);
}

export function useWorkspaceActions(): WorkspaceActionsContextValue {
  const context = useContext(WorkspaceActionsContext);
  if (!context) {
    throw new Error("Workspace hooks must be used within a WorkspaceProvider.");
  }
  return context;
}
