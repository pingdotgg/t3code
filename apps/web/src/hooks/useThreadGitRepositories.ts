import {
  threadChangedRepositories,
  threadGitRepositories,
  type ThreadGitRepository,
} from "@t3tools/client-runtime/state/thread-repositories";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadProjection } from "~/state/entities";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";

const NO_GIT_REPOSITORIES: ReadonlyArray<ThreadGitRepository> = Object.freeze([]);

/**
 * Every repository besides its own folder whose Git state a thread can show: the ones it changed,
 * then its task folder's worktrees, or the project's tracked repositories when it runs in place.
 * A project that tracks no folders asks the server nothing.
 */
export function useThreadGitRepositories(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** False for a draft, which has changed nothing yet. */
  readonly isServerThread: boolean;
  readonly projectId: ProjectId | null;
  readonly worktreePath: string | null;
  readonly threadCwd: string | null;
  /**
   * False while nothing reads the list. A thread in its own worktree keeps its task folder when
   * the project stops tracking folders, so only an in-place thread needs the project to track some.
   */
  readonly enabled: boolean;
}): {
  readonly repositories: ReadonlyArray<ThreadGitRepository>;
  /** The worktree thread's task folder, once read; null otherwise. */
  readonly taskFolder: { readonly projectIsWorktree: boolean } | null;
  /**
   * Whether the folders this thread reaches have been read, or failed to be: a repository not
   * listed by then is out of reach. True when nothing is read, as for a project that tracks none.
   */
  readonly settled: boolean;
} {
  const { threadRef, worktreePath, enabled } = input;
  const structure = useQuietThreadProjection(input.isServerThread ? threadRef : null);
  const taskFolderAtom =
    enabled && threadRef !== null && worktreePath !== null
      ? filesystemEnvironment.taskFolder({
          environmentId: threadRef.environmentId,
          input: { worktreePath },
        })
      : null;
  const foldersAtom =
    enabled && threadRef !== null && input.projectId !== null && worktreePath === null
      ? filesystemEnvironment.listFolders({
          environmentId: threadRef.environmentId,
          input: { projectId: input.projectId },
        })
      : null;
  const taskFolderQuery = useEnvironmentQuery(taskFolderAtom);
  const foldersQuery = useEnvironmentQuery(foldersAtom);
  const read =
    taskFolderAtom !== null ? taskFolderQuery : foldersAtom !== null ? foldersQuery : null;
  const taskFolder = taskFolderQuery.data?.taskFolder ?? null;
  return {
    repositories: threadGitRepositories({
      changed:
        structure === null ? NO_GIT_REPOSITORIES : threadChangedRepositories(structure.projection),
      taskFolder,
      folders: foldersQuery.data?.folders ?? null,
      threadCwd: input.threadCwd,
    }),
    taskFolder,
    settled: read === null || read.isSuccess || read.error !== null,
  };
}
