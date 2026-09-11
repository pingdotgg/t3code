import type { WorkspaceRepository } from "@t3tools/contracts";

export function resolveWorkspaceGitCwd(
  workspaceCwd: string | null,
  selectedPath: string | null,
  repositories: readonly Pick<WorkspaceRepository, "path" | "cwd" | "available">[],
): string | null {
  if (selectedPath === null || selectedPath === ".") return workspaceCwd;
  return (
    repositories.find((repository) => repository.path === selectedPath && repository.available)
      ?.cwd ?? null
  );
}

export interface WorkspaceRepositorySelection {
  readonly path: string | null;
  readonly diffPath: string | null;
}

export function updateWorkspaceRepositorySelection(
  current: WorkspaceRepositorySelection,
  path: string | null,
): WorkspaceRepositorySelection {
  return { path: path ?? current.path, diffPath: path };
}

export function resolveWorkspaceRepositoryFilter(
  selectedPath: string | null,
  repositories: readonly Pick<WorkspaceRepository, "path" | "available">[],
): string | null {
  return repositories.some((repository) => repository.path === selectedPath && repository.available)
    ? selectedPath
    : null;
}
