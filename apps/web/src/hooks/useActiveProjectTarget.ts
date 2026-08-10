import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { resolveWorkspaceFolders, type WorkspaceFolder } from "@t3tools/shared/workspaceFolders";

import { useProjects } from "~/state/entities";

import { useHandleNewThread } from "./useHandleNewThread";

export interface ActiveProjectTarget {
  readonly environmentId: EnvironmentId;
  /**
   * The primary folder's cwd (the thread's worktree when it has one).
   *
   * Unchanged by source folders so every existing single-root consumer keeps
   * working; surfaces that span folders read {@link folders} instead.
   */
  readonly cwd: string;
  readonly projectName: string;
  readonly threadRef: ScopedThreadRef;
  /** Every source folder, primary first. `folders[0].cwd === cwd`. */
  readonly folders: ReadonlyArray<WorkspaceFolder>;
}

/**
 * Resolves the project workspace behind the active thread (or draft) so
 * project-scoped surfaces like the file picker and content search know which
 * workspace to query and which thread's right panel opens their results.
 */
export function useActiveProjectTarget(): ActiveProjectTarget | null {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projects = useProjects();
  const thread = activeThread ?? activeDraftThread;
  const threadId = activeThread?.id ?? activeDraftThread?.threadId;
  const project = thread
    ? projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      )
    : null;
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;

  if (!thread || !threadId || !project || !cwd) return null;

  return {
    environmentId: project.environmentId,
    cwd,
    projectName: project.title,
    threadRef: scopeThreadRef(thread.environmentId, threadId),
    folders: resolveWorkspaceFolders({
      primaryRoot: project.workspaceRoot,
      worktreePath: thread.worktreePath ?? null,
      additionalFolders: project.additionalFolders,
    }),
  };
}
