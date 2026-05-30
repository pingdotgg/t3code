import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { EnvironmentScopedThreadShell } from "@t3tools/client-runtime";
import { EnvironmentScopedProjectShell } from "@t3tools/client-runtime";
import { useRemoteCatalog } from "./use-remote-catalog";
import { useRemoteEnvironmentState } from "./use-remote-environment-registry";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function deriveSelectedThread(
  selectedThreadRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
  threads: ReadonlyArray<EnvironmentScopedThreadShell>,
): EnvironmentScopedThreadShell | null {
  if (!selectedThreadRef) {
    return null;
  }

  return (
    threads.find(
      (thread) =>
        thread.environmentId === selectedThreadRef.environmentId &&
        thread.id === selectedThreadRef.threadId,
    ) ?? null
  );
}

function deriveSelectedThreadProject(
  selectedThread: EnvironmentScopedThreadShell | null,
  projects: ReadonlyArray<EnvironmentScopedProjectShell>,
): EnvironmentScopedProjectShell | null {
  if (!selectedThread) {
    return null;
  }

  return (
    projects.find(
      (project) =>
        project.environmentId === selectedThread.environmentId &&
        project.id === selectedThread.projectId,
    ) ?? null
  );
}

export function useThreadSelection() {
  const { projects, threads } = useRemoteCatalog();
  const { environmentStateById, savedConnectionsById } = useRemoteEnvironmentState();
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const selectedThreadRef = useMemo(() => {
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
  const selectedThread = useMemo(
    () => deriveSelectedThread(selectedThreadRef, threads),
    [selectedThreadRef, threads],
  );

  const selectedThreadProject = useMemo(
    () => deriveSelectedThreadProject(selectedThread, projects),
    [projects, selectedThread],
  );

  const selectedEnvironmentConnection = selectedThread
    ? (savedConnectionsById[selectedThread.environmentId] ?? null)
    : null;
  const selectedEnvironmentRuntime = selectedThread
    ? (environmentStateById[selectedThread.environmentId] ?? null)
    : null;

  return {
    selectedThreadRef,
    selectedThread,
    selectedThreadProject,
    selectedEnvironmentConnection,
    selectedEnvironmentRuntime,
  };
}
