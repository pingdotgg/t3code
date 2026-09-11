export function selectWorkspaceRepository<
  T extends { readonly path: string; readonly available: boolean },
>(repositories: readonly T[], selectedPath: string | null): T | null {
  if (selectedPath !== null) {
    return (
      repositories.find((repository) => repository.path === selectedPath && repository.available) ??
      null
    );
  }
  return (
    repositories.find((repository) => repository.path !== "." && repository.available) ??
    repositories.find((repository) => repository.available) ??
    null
  );
}

export function updateWorkspaceRepositorySelection(
  current: { path: string | null; diffPath: string | null } | null,
  path: string | null,
) {
  return { path: path ?? current?.path ?? null, diffPath: path };
}
