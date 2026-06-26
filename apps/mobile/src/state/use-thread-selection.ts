import { useGlobalSearchParams } from "expo-router";
import { createContext, createElement, use, useMemo, useRef, type ReactNode } from "react";
import {
  EnvironmentId,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { useProject, useThreadShell } from "../state/entities";
import {
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnection,
} from "./use-remote-environment-registry";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function useResolvedThreadSelection() {
  const params = useGlobalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const routeThreadRef = useMemo<ScopedThreadRef | null>(() => {
    const environmentId = firstRouteParam(params.environmentId);
    const threadId = firstRouteParam(params.threadId);
    if (!environmentId || !threadId) {
      return null;
    }

    return {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
    };
  }, [params.environmentId, params.threadId]);
  const lastRouteThreadRef = useRef<ScopedThreadRef | null>(null);
  if (routeThreadRef !== null) {
    lastRouteThreadRef.current = routeThreadRef;
  }
  const selectedThreadRef = routeThreadRef ?? lastRouteThreadRef.current;
  const selectedThread = useThreadShell(selectedThreadRef);
  const selectedProjectRef = useMemo<ScopedProjectRef | null>(
    () =>
      selectedThread === null
        ? null
        : {
            environmentId: selectedThread.environmentId,
            projectId: selectedThread.projectId,
          },
    [selectedThread],
  );
  const selectedThreadProject = useProject(selectedProjectRef);
  const selectedEnvironmentId = selectedThread?.environmentId ?? null;
  const selectedEnvironmentConnection = useSavedRemoteConnection(selectedEnvironmentId);
  const selectedEnvironmentRuntime = useRemoteEnvironmentRuntime(selectedEnvironmentId);

  return useMemo(
    () => ({
      selectedThreadRef,
      selectedThread,
      selectedThreadProject,
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
    }),
    [
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
      selectedThread,
      selectedThreadProject,
      selectedThreadRef,
    ],
  );
}

type ThreadSelectionState = ReturnType<typeof useResolvedThreadSelection>;

const ThreadSelectionContext = createContext<ThreadSelectionState | null>(null);

export function ThreadSelectionProvider(props: { readonly children: ReactNode }) {
  const selection = useResolvedThreadSelection();
  return createElement(ThreadSelectionContext.Provider, { value: selection }, props.children);
}

export function useThreadSelection(): ThreadSelectionState {
  const selection = use(ThreadSelectionContext);
  if (selection === null) {
    throw new Error("useThreadSelection must be used within ThreadSelectionProvider");
  }
  return selection;
}
