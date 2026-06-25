import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { EnvironmentId, ThreadId, type ScopedProjectRef } from "@t3tools/contracts";

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

export function useThreadSelection() {
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

  return {
    selectedThreadRef,
    selectedThread,
    selectedThreadProject,
    selectedEnvironmentConnection,
    selectedEnvironmentRuntime,
  };
}
