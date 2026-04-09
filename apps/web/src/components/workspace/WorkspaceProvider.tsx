import { useNavigate, useSearch } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useStore as useZustandStore } from "zustand";

import { parseDiffRouteSearch } from "~/diffRouteSearch";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "~/threadRoutes";
import {
  createWorkspaceStore,
  type OpenSurfaceFn,
  selectResolvedWorkspaceState,
  type UpdateSurfaceFn,
  type WorkspaceNavigationOptions,
  type WorkspaceStore,
  type WorkspaceStoreApi,
} from "~/workspace/store";
import { buildWorkspaceRouteSearch, resolveWorkspaceState } from "~/workspace/urlState";
import type { SecondarySurface, WorkspaceState, WorkspaceTarget } from "~/workspace/types";

const WorkspaceStoreContext = createContext<WorkspaceStoreApi | null>(null);

export function WorkspaceProvider(props: { target: WorkspaceTarget; children: ReactNode }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false, select: (value) => parseDiffRouteSearch(value) });
  const resolvedState = useMemo(
    () => resolveWorkspaceState(props.target, search),
    [props.target, search],
  );
  const latestRouteRef = useRef<{
    target: WorkspaceTarget;
    resolvedState: WorkspaceState;
  }>({
    target: props.target,
    resolvedState,
  });
  const storeRef = useRef<WorkspaceStoreApi | null>(null);
  if (!storeRef.current) {
    storeRef.current = createWorkspaceStore(resolvedState, {
      navigateToState: (nextState, options) => {
        const latestRoute = latestRouteRef.current;

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
    });
  }

  const store = storeRef.current;
  latestRouteRef.current = {
    target: props.target,
    resolvedState,
  };

  useEffect(() => {
    store.getState().syncRouteState(resolvedState);
  }, [resolvedState, store]);

  return (
    <WorkspaceStoreContext.Provider value={store}>{props.children}</WorkspaceStoreContext.Provider>
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
  return useWorkspaceStore(selectResolvedWorkspaceState);
}

export function useWorkspaceSecondarySurface(): SecondarySurface | null {
  return useWorkspaceStore((state) => selectResolvedWorkspaceState(state).surfaces.secondary);
}

export function useWorkspaceActions(): {
  openSurface: OpenSurfaceFn;
  closeSurface: (placement: "secondary", options?: WorkspaceNavigationOptions) => void;
  updateSurface: UpdateSurfaceFn;
} {
  const store = useWorkspaceStoreApiInternal();

  return useMemo(() => {
    const { openSurface, closeSurface, updateSurface } = store.getState();
    return { openSurface, closeSurface, updateSurface };
  }, [store]);
}
