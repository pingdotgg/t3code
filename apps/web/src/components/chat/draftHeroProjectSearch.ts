type SearchableProject = {
  readonly title: string;
  readonly workspaceRoot: string;
};

export function filterDraftHeroProjects<T extends SearchableProject>(
  projects: ReadonlyArray<T>,
  query: string,
): T[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return [...projects];
  }

  return projects.filter((project) => {
    const searchText = `${project.title}\n${project.workspaceRoot}`.toLocaleLowerCase();
    return tokens.every((token) => searchText.includes(token));
  });
}
