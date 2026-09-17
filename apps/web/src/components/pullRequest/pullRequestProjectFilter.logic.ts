import type { EnvironmentId } from "@t3tools/contracts";

import type { AssignableProject } from "./pullRequestProjectAssignment.logic";

interface FilterProject extends AssignableProject {
  readonly title: string;
  readonly workspaceRoot: string;
}

function distinguishTitles<Project extends FilterProject>(
  projects: ReadonlyArray<Project>,
  suffix: (project: Project) => string,
) {
  const counts = new Map<string, number>();
  for (const project of projects) {
    counts.set(project.title, (counts.get(project.title) ?? 0) + 1);
  }
  return projects.map((project) =>
    (counts.get(project.title) ?? 0) > 1
      ? { ...project, title: `${project.title} · ${suffix(project)}` }
      : project,
  );
}

/** One choice per repository per server, retaining the selected checkout for saved scopes. */
export function pullRequestFilterProjects<Project extends FilterProject>(
  projects: ReadonlyArray<Project>,
  environmentLabels: ReadonlyMap<EnvironmentId, string>,
  selectedProject?: Pick<AssignableProject, "id" | "environmentId">,
) {
  const byRepository = new Map<string, Project>();
  for (const project of projects) {
    const repository = project.repositoryIdentity?.canonicalKey?.toLowerCase();
    const key = JSON.stringify([
      project.environmentId,
      repository ? ["repository", repository] : ["project", project.id],
    ]);
    const selected =
      project.id === selectedProject?.id && project.environmentId === selectedProject.environmentId;
    if (!byRepository.has(key) || selected) byRepository.set(key, project);
  }

  const byServer = distinguishTitles(
    [...byRepository.values()],
    (project) => environmentLabels.get(project.environmentId) ?? project.environmentId,
  );
  const byPath = distinguishTitles(byServer, (project) => project.workspaceRoot);
  // Separate environments can share both their display name and their checkout path.
  const byEnvironment = distinguishTitles(byPath, (project) => project.environmentId);
  return distinguishTitles(byEnvironment, (project) => project.id).toSorted((left, right) =>
    left.title.localeCompare(right.title),
  );
}
