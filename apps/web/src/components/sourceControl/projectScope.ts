/**
 * The project scope to actually ask for. A `projectId` in the URL outlives the environment it
 * came from, and one from elsewhere narrows the listing to nothing — an empty page with no
 * visible filter explaining it, since the switcher has no such project to show as selected. So
 * an id the environment does not have is dropped.
 *
 * Until `projectsKnown`, the id is kept rather than dropped: an environment that has not
 * reported yet is not the same as one without the project, and dropping first would show every
 * project's pull requests for a moment before narrowing back down.
 */
export function resolveProjectScope<Id extends string>(
  projectId: Id | undefined,
  projects: ReadonlyArray<{ readonly id: string }>,
  projectsKnown: boolean,
): Id | undefined {
  if (projectId === undefined || !projectsKnown) return projectId;
  return projects.some((project) => project.id === projectId) ? projectId : undefined;
}
