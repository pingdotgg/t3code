import { threadRepositoriesTarget } from "@t3tools/client-runtime/state/thread-repositories";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  ScopedThreadRef,
  WorkspaceListRepositoriesResult,
  WorkspaceRepository,
} from "@t3tools/contracts";

import { useProject, useQuietThreadShell } from "./entities";
import { useEnvironmentQuery } from "./query";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";
import { useThreadSelection } from "./use-thread-selection";
import { workspaceRepositoryEnvironment } from "./workspaceRepositories";

const EMPTY_REPOSITORIES: ReadonlyArray<WorkspaceRepository> = Object.freeze([]);
const EMPTY_REFERENCES: WorkspaceListRepositoriesResult["references"] = Object.freeze([]);

export interface ThreadRepositories {
  /** Home first when it is a Git repo. Empty for projects without tracked folders. */
  readonly repositories: ReadonlyArray<WorkspaceRepository>;
  readonly references: WorkspaceListRepositoriesResult["references"];
  readonly taskFolder: WorkspaceListRepositoriesResult["taskFolder"];
  /** The thread reaches a tracked Git folder, so Git and diffs work per repo. */
  readonly multiRepository: boolean;
  /** The project tracks folders and the list has not answered yet. */
  readonly loading: boolean;
}

/**
 * The repos a thread works in. Projects without tracked folders send no request and list none,
 * so single-repo threads keep today's single-cwd paths.
 */
export function useThreadRepositories(input: {
  readonly environmentId: EnvironmentId | null;
  readonly project: Pick<
    OrchestrationProjectShell,
    "id" | "workspaceRoot" | "trackedFolders"
  > | null;
  /** The thread's cwd: its worktree, or the project's home folder. */
  readonly cwd: string | null;
}): ThreadRepositories {
  const { environmentId, project, cwd } = input;
  const target =
    environmentId === null || cwd === null
      ? null
      : threadRepositoriesTarget({ environmentId, project, worktreePath: cwd });
  const query = useEnvironmentQuery(
    target === null ? null : workspaceRepositoryEnvironment.repositories(target),
  );
  const repositories = query.data?.repositories ?? EMPTY_REPOSITORIES;
  return {
    repositories,
    references: query.data?.references ?? EMPTY_REFERENCES,
    taskFolder: query.data?.taskFolder ?? null,
    multiRepository: repositories.some((repository) => repository.kind === "repository"),
    loading: target !== null && query.data === null && query.error === null,
  };
}

export function useSelectedThreadRepositories(): ThreadRepositories {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  return useThreadRepositories({
    environmentId: selectedThread?.environmentId ?? null,
    project: selectedThreadProject,
    cwd: selectedThreadCwd,
  });
}

/** For views of a thread that need not be the route's selected thread. */
export function useThreadRepositoriesForThread(
  ref: ScopedThreadRef | null,
  cwd: string | null,
): ThreadRepositories {
  const shell = useQuietThreadShell(ref);
  const project = useProject(
    ref === null || shell === null
      ? null
      : { environmentId: ref.environmentId, projectId: shell.projectId },
  );
  return useThreadRepositories({ environmentId: ref?.environmentId ?? null, project, cwd });
}
