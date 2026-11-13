/**
 * A tracked repository the Git sheets act on instead of the thread's own folder. The thread still
 * owns the work, but its branch and worktree never follow this folder.
 */
export interface GitRepositoryTarget {
  /** Tells the folder from the others shown beside it; the repository's path. */
  readonly key: string;
  readonly cwd: string;
  readonly name: string;
}

// A type alias, not an interface: route params need an implicit index signature.
export type GitRepositoryRouteParams = {
  readonly repositoryCwd?: string;
  readonly repositoryName?: string;
};

function folderName(cwd: string): string {
  return cwd.replaceAll("\\", "/").split("/").findLast(Boolean) ?? cwd;
}

/** Undefined when the route acts on the thread's own folder. */
export function gitRepositoryTargetFromRoute(
  params: GitRepositoryRouteParams,
): GitRepositoryTarget | undefined {
  const cwd = params.repositoryCwd?.trim() ?? "";
  if (cwd.length === 0) return undefined;
  const name = params.repositoryName?.trim() ?? "";
  return { key: cwd, cwd, name: name.length > 0 ? name : folderName(cwd) };
}

export function gitRepositoryRouteParams(
  repository: GitRepositoryTarget | undefined,
): GitRepositoryRouteParams {
  return repository === undefined
    ? {}
    : { repositoryCwd: repository.cwd, repositoryName: repository.name };
}
