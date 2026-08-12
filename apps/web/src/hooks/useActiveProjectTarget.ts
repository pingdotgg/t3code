import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useProjects, useThread } from "~/state/entities";

import { useHandleNewThread } from "./useHandleNewThread";

export interface ActiveProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly roots: ReadonlyArray<string>;
  readonly projectName: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Resolves the project workspace behind the active thread (or draft) so
 * project-scoped surfaces like the file picker and content search know which
 * workspace to query and which thread's right panel opens their results.
 */
export function useActiveProjectTarget(): ActiveProjectTarget | null {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projects = useProjects();
  // Draft routes remain stable after the first send. Once the server thread is
  // materialized, prefer its authoritative worktree map over the draft's
  // singular compatibility path so multi-repo isolated searches span every
  // worktree.
  const promotedThreadRef = activeDraftThread
    ? (activeDraftThread.promotedTo ??
      scopeThreadRef(activeDraftThread.environmentId, activeDraftThread.threadId))
    : null;
  const promotedThread = useThread(promotedThreadRef, { waitForShell: true });
  const thread = activeThread ?? promotedThread ?? activeDraftThread;
  const threadId = activeThread?.id ?? promotedThread?.id ?? activeDraftThread?.threadId;
  const project = thread
    ? projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      )
    : null;
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;

  if (!thread || !threadId || !project || !cwd) return null;

  const worktrees = "worktrees" in thread ? thread.worktrees : [];

  return {
    environmentId: project.environmentId,
    cwd,
    roots:
      worktrees.length > 0
        ? worktrees.map((worktree) => worktree.worktreePath)
        : thread.worktreePath
          ? [thread.worktreePath]
          : project.repoRoots && project.repoRoots.length > 0
            ? project.repoRoots
            : [project.workspaceRoot],
    projectName: project.title,
    threadRef: scopeThreadRef(thread.environmentId, threadId),
  };
}
