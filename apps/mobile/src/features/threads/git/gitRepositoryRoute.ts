import type { WorkspaceRepository } from "@t3tools/contracts";

import type { ThreadGitRepositoryTarget } from "../../../state/use-selected-thread-git-actions";

/**
 * Names the repo a Git sheet acts on. Absent for single-repo threads, which act on the thread.
 * A type alias, as route params must be assignable to `Record<string, unknown>`.
 */
export type GitRepositoryRouteParams = {
  readonly repositoryCwd?: string;
  readonly repositoryName?: string;
  readonly repositoryHome?: string;
};

export interface GitRouteRepository {
  readonly name: string;
  readonly target: ThreadGitRepositoryTarget;
}

export function gitRouteRepository(
  repository: Pick<WorkspaceRepository, "name" | "cwd" | "kind">,
): GitRouteRepository {
  return {
    name: repository.name,
    target: { cwd: repository.cwd, home: repository.kind === "home" },
  };
}

export function gitRepositoryRouteParams(
  repository: GitRouteRepository | undefined,
): GitRepositoryRouteParams {
  return repository === undefined
    ? {}
    : {
        repositoryCwd: repository.target.cwd,
        repositoryName: repository.name,
        repositoryHome: String(repository.target.home),
      };
}

export function gitRepositoryFromRouteParams(
  params: GitRepositoryRouteParams,
): GitRouteRepository | undefined {
  return params.repositoryCwd
    ? {
        name: params.repositoryName ?? params.repositoryCwd,
        target: { cwd: params.repositoryCwd, home: params.repositoryHome === "true" },
      }
    : undefined;
}
