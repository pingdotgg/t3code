import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

export const UNGROUPED_CHAT_PROJECT_TITLE = "Chats not in a project";

export interface SidebarPlatformProjectGroup {
  readonly key: string;
  readonly title: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly threadCount: number;
}

export interface SidebarPlatformGroup {
  readonly key: string;
  readonly label: string;
  readonly driver: ProviderDriverKind | null;
  readonly projects: ReadonlyArray<SidebarPlatformProjectGroup>;
  readonly threadCount: number;
}

export function buildSidebarPlatformGroups(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly totalThreads?: ReadonlyArray<EnvironmentThreadShell>;
  readonly driverByInstanceId: ReadonlyMap<string, ProviderDriverKind>;
  readonly projectTitleByKey: ReadonlyMap<string, string>;
  readonly platformLabel: (
    driver: ProviderDriverKind | null,
    instanceId: ProviderInstanceId,
  ) => string;
}): ReadonlyArray<SidebarPlatformGroup> {
  const totalPlatformCounts = new Map<string, number>();
  const totalProjectCounts = new Map<string, number>();
  for (const thread of input.totalThreads ?? input.threads) {
    const driver = input.driverByInstanceId.get(thread.modelSelection.instanceId) ?? null;
    const platformKey = driver ?? `instance:${thread.modelSelection.instanceId}`;
    const projectKey = `${platformKey}:${thread.environmentId}:${thread.projectId}`;
    totalPlatformCounts.set(platformKey, (totalPlatformCounts.get(platformKey) ?? 0) + 1);
    totalProjectCounts.set(projectKey, (totalProjectCounts.get(projectKey) ?? 0) + 1);
  }
  const platforms = new Map<
    string,
    {
      label: string;
      driver: ProviderDriverKind | null;
      projects: Map<string, { title: string; threads: EnvironmentThreadShell[] }>;
    }
  >();

  for (const thread of input.threads) {
    const instanceId = thread.modelSelection.instanceId;
    const driver = input.driverByInstanceId.get(instanceId) ?? null;
    const platformKey = driver ?? `instance:${instanceId}`;
    let platform = platforms.get(platformKey);
    if (!platform) {
      platform = {
        label: input.platformLabel(driver, instanceId),
        driver,
        projects: new Map(),
      };
      platforms.set(platformKey, platform);
    }
    const projectKey = `${thread.environmentId}:${thread.projectId}`;
    const projectTitle = input.projectTitleByKey.get(projectKey) ?? UNGROUPED_CHAT_PROJECT_TITLE;
    let project = platform.projects.get(projectKey);
    if (!project) {
      project = { title: projectTitle, threads: [] };
      platform.projects.set(projectKey, project);
    }
    project.threads.push(thread);
  }

  return [...platforms.entries()].map(([key, platform]) => {
    const projects = [...platform.projects.entries()]
      .map(([projectKey, project]) => ({ key: projectKey, ...project }))
      .map((project) => ({
        ...project,
        threadCount: totalProjectCounts.get(`${key}:${project.key}`) ?? project.threads.length,
      }))
      .toSorted((left, right) => {
        const leftUngrouped = left.title === UNGROUPED_CHAT_PROJECT_TITLE;
        const rightUngrouped = right.title === UNGROUPED_CHAT_PROJECT_TITLE;
        if (leftUngrouped !== rightUngrouped) return leftUngrouped ? 1 : -1;
        return 0;
      });
    return {
      key,
      label: platform.label,
      driver: platform.driver,
      projects,
      threadCount:
        totalPlatformCounts.get(key) ??
        projects.reduce((total, project) => total + project.threads.length, 0),
    };
  });
}
