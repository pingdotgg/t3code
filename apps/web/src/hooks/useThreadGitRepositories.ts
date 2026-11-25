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
  /** False while nothing reads the list, or when the project tracks no folders. */
  readonly enabled: boolean;
}): ReadonlyArray<ThreadGitRepository> {
  const { threadRef, worktreePath, enabled } = input;
  const structure = useQuietThreadProjection(input.isServerThread ? threadRef : null);
  const taskFolderQuery = useEnvironmentQuery(
    enabled && threadRef !== null && worktreePath !== null
      ? filesystemEnvironment.taskFolder({
          environmentId: threadRef.environmentId,
          input: { worktreePath },
        })
      : null,
  );
  const foldersQuery = useEnvironmentQuery(
    enabled && threadRef !== null && input.projectId !== null && worktreePath === null
      ? filesystemEnvironment.listFolders({
          environmentId: threadRef.environmentId,
          input: { projectId: input.projectId },
        })
      : null,
  );
  return threadGitRepositories({
    changed:
      structure === null ? NO_GIT_REPOSITORIES : threadChangedRepositories(structure.projection),
    taskFolder: taskFolderQuery.data?.taskFolder ?? null,
    folders: foldersQuery.data?.folders ?? null,
    threadCwd: input.threadCwd,
  });
}
