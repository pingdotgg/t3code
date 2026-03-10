import type { ProjectId } from "@t3tools/contracts";

import type { Project, Thread } from "./types";

export interface SidebarProjectTreeNode {
  project: Project;
  threads: Thread[];
  childProjects: SidebarProjectTreeNode[];
}

export function sanitizeProjectParents(projects: Project[]): Project[] {
  const projectById = new Map(projects.map((project) => [project.id, project] as const));

  return projects.map((project) => {
    const originalParentProjectId = project.parentProjectId;
    if (originalParentProjectId === null) {
      return project;
    }

    let currentParentId: ProjectId | null = originalParentProjectId;
    const seen = new Set<ProjectId>([project.id]);
    while (currentParentId !== null) {
      if (seen.has(currentParentId) || !projectById.has(currentParentId)) {
        return { ...project, parentProjectId: null };
      }
      seen.add(currentParentId);
      currentParentId = projectById.get(currentParentId)?.parentProjectId ?? null;
    }

    return project;
  });
}

export function isProjectDescendant(
  projects: Project[],
  potentialDescendantId: ProjectId,
  ancestorProjectId: ProjectId,
): boolean {
  const parentById = new Map(projects.map((project) => [project.id, project.parentProjectId] as const));
  let currentParentId = parentById.get(potentialDescendantId) ?? null;

  while (currentParentId !== null) {
    if (currentParentId === ancestorProjectId) {
      return true;
    }
    currentParentId = parentById.get(currentParentId) ?? null;
  }

  return false;
}

export function buildSidebarProjectTree(
  projects: Project[],
  threads: Thread[],
): SidebarProjectTreeNode[] {
  const childProjectsByParentId = new Map<ProjectId | null, Project[]>();
  for (const project of projects) {
    const siblings = childProjectsByParentId.get(project.parentProjectId) ?? [];
    siblings.push(project);
    childProjectsByParentId.set(project.parentProjectId, siblings);
  }

  const threadsByProjectId = new Map<ProjectId, Thread[]>();
  for (const thread of threads) {
    const projectThreads = threadsByProjectId.get(thread.projectId) ?? [];
    projectThreads.push(thread);
    threadsByProjectId.set(thread.projectId, projectThreads);
  }

  const buildNode = (project: Project): SidebarProjectTreeNode => ({
    project,
    threads: threadsByProjectId.get(project.id) ?? [],
    childProjects: (childProjectsByParentId.get(project.id) ?? []).map(buildNode),
  });

  return (childProjectsByParentId.get(null) ?? []).map(buildNode);
}
