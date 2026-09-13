import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { useProjects } from "~/state/entities";
import { useTaskWorkbench } from "~/state/taskWorkbench";
import { resolveThreadRouteTarget } from "~/threadRoutes";

import { useHandleNewThread } from "./useHandleNewThread";

export interface ActiveProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * File picker and content search follow the same workbench root as the file tree.
 */
export function useActiveProjectTarget(): ActiveProjectTarget | null {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projects = useProjects();
  const route = useParams({ strict: false, select: resolveThreadRouteTarget });
  const thread = activeThread ?? activeDraftThread;
  const threadId = activeThread?.id ?? activeDraftThread?.threadId;
  const environmentId = thread?.environmentId;
  const threadRef = useMemo(
    () => (environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null),
    [environmentId, threadId],
  );
  const { ref: workbenchRef, task } = useTaskWorkbench(
    threadRef,
    thread,
    route?.kind === "task" ? route.taskRef : null,
  );
  const project = task
    ? projects.find(
        (candidate) =>
          candidate.environmentId === task.environmentId && candidate.id === task.primaryProjectId,
      )
    : thread
      ? projects.find(
          (candidate) =>
            candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
        )
      : null;
  const cwd = task ? project?.workspaceRoot : (thread?.worktreePath ?? project?.workspaceRoot);

  if (!workbenchRef || !project || !cwd) return null;

  return {
    environmentId: project.environmentId,
    cwd,
    projectName: project.title,
    threadRef: workbenchRef,
  };
}
