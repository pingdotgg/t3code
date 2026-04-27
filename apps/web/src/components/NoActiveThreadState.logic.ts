import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@forma/contracts/settings";
import { orderItemsByPreferredIds, sortProjectsForSidebar } from "./Sidebar.logic";
import { getProjectOrderKey } from "../logicalProject";
import { sortThreads } from "../lib/threadSort";
import type { Project, SidebarThreadSummary } from "../types";

export const NO_ACTIVE_THREAD_LIST_LIMIT = 6;

export type NoActiveThreadStateVariant = "no-projects" | "projects-no-threads" | "recent-threads";

export interface NoActiveThreadRecentThreadItem {
  thread: SidebarThreadSummary;
  projectName: string | null;
}

export interface NoActiveThreadProjectItem {
  project: Project;
  latestThread: SidebarThreadSummary | null;
}

function getVisibleThreads(threads: readonly SidebarThreadSummary[]): SidebarThreadSummary[] {
  return threads.filter((thread) => thread.archivedAt === null);
}

function projectThreadKey(input: {
  environmentId: Project["environmentId"] | SidebarThreadSummary["environmentId"];
  projectId: Project["id"] | SidebarThreadSummary["projectId"];
}): string {
  return `${input.environmentId}:${input.projectId}`;
}

export function resolveNoActiveThreadStateVariant(input: {
  projects: readonly Project[];
  threads: readonly SidebarThreadSummary[];
}): NoActiveThreadStateVariant {
  if (input.projects.length === 0) {
    return "no-projects";
  }

  return getVisibleThreads(input.threads).length === 0 ? "projects-no-threads" : "recent-threads";
}

export function getNoActiveThreadRecentThreadItems(input: {
  threads: readonly SidebarThreadSummary[];
  projectNameById: ReadonlyMap<Project["id"], string>;
  sortOrder: SidebarThreadSortOrder;
  limit?: number;
}): NoActiveThreadRecentThreadItem[] {
  const limit = input.limit ?? NO_ACTIVE_THREAD_LIST_LIMIT;

  return sortThreads(getVisibleThreads(input.threads), input.sortOrder)
    .slice(0, limit)
    .map((thread) => ({
      thread,
      projectName: input.projectNameById.get(thread.projectId) ?? null,
    }));
}

export function getNoActiveThreadProjectItems(input: {
  projects: readonly Project[];
  threads: readonly SidebarThreadSummary[];
  projectOrder: readonly string[];
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  limit?: number;
}): NoActiveThreadProjectItem[] {
  const limit = input.limit ?? NO_ACTIVE_THREAD_LIST_LIMIT;
  const visibleThreads = getVisibleThreads(input.threads);
  const latestThreadByProjectKey = new Map<string, SidebarThreadSummary>();

  for (const thread of sortThreads(visibleThreads, input.threadSortOrder)) {
    const key = projectThreadKey({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    });
    if (!latestThreadByProjectKey.has(key)) {
      latestThreadByProjectKey.set(key, thread);
    }
  }

  const sortedProjects =
    input.projectSortOrder === "manual"
      ? orderItemsByPreferredIds({
          items: input.projects,
          preferredIds: input.projectOrder,
          getId: getProjectOrderKey,
        })
      : sortProjectsForSidebar(input.projects, visibleThreads, input.projectSortOrder);

  return sortedProjects.slice(0, limit).map((project) => ({
    project,
    latestThread:
      latestThreadByProjectKey.get(
        projectThreadKey({ environmentId: project.environmentId, projectId: project.id }),
      ) ?? null,
  }));
}
