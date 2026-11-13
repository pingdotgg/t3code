import {
  worktreeRepositoryChoices,
  type WorktreeRepositoryChoice,
} from "@t3tools/client-runtime/state/thread-repositories";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";

interface WorktreeRepositoryChoices {
  /** The project's tracked Git folders. Null while they load or when they cannot be read. */
  readonly choices: ReadonlyArray<WorktreeRepositoryChoice> | null;
  /** Whether a worktree thread has a repository to work in besides the project folder. */
  readonly tracksGitRepositories: boolean;
}

const NO_TRACKED_FOLDERS: WorktreeRepositoryChoices = Object.freeze({
  choices: Object.freeze([]),
  tracksGitRepositories: false,
});

/**
 * The tracked Git folders a new worktree thread of this project can take. A project that tracks
 * no folders asks the server nothing.
 */
export function useWorktreeRepositoryChoices(
  project: Pick<
    EnvironmentProject,
    "environmentId" | "id" | "workspaceRoot" | "trackedFolders"
  > | null,
): WorktreeRepositoryChoices {
  const tracksFolders = (project?.trackedFolders?.length ?? 0) > 0;
  const folders = useEnvironmentQuery(
    project !== null && tracksFolders
      ? filesystemEnvironment.listFolders({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        })
      : null,
  );
  if (project === null || !tracksFolders) return NO_TRACKED_FOLDERS;
  if (folders.data === null) {
    // Until the folders arrive the tracked list stands in, as the checkout's Git state does.
    return { choices: null, tracksGitRepositories: folders.error === null };
  }
  const choices = worktreeRepositoryChoices({
    folders: folders.data.folders,
    projectRoot: project.workspaceRoot,
  });
  return { choices, tracksGitRepositories: choices.length > 0 };
}
