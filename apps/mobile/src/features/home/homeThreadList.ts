import {
  deriveLogicalProjectKey,
  deriveProjectGroupLabel,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp, sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";

export type HomeProjectSortOrder = Exclude<SidebarProjectSortOrder, "manual">;

export interface HomeThreadGroup {
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

interface MutableHomeThreadGroup {
  readonly key: string;
  readonly projects: EnvironmentProject[];
  readonly threads: EnvironmentThreadShell[];
}

function groupSortTimestamp(group: HomeThreadGroup, sortOrder: HomeProjectSortOrder): number {
  return group.threads.reduce(
    (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
    Number.NEGATIVE_INFINITY,
  );
}

export function buildHomeThreadGroups(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}): ReadonlyArray<HomeThreadGroup> {
  const groups = new Map<string, MutableHomeThreadGroup>();
  const groupKeyByProjectKey = new Map<string, string>();

  for (const project of input.projects) {
    if (input.environmentId !== null && project.environmentId !== input.environmentId) {
      continue;
    }

    const groupKey = deriveLogicalProjectKey(project, {
      groupingMode: input.projectGroupingMode,
    });
    const physicalKey = scopedProjectKey(project.environmentId, project.id);
    groupKeyByProjectKey.set(physicalKey, groupKey);

    const existing = groups.get(groupKey);
    if (existing) {
      existing.projects.push(project);
    } else {
      groups.set(groupKey, { key: groupKey, projects: [project], threads: [] });
    }
  }

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) {
      continue;
    }

    const physicalKey = scopedProjectKey(thread.environmentId, thread.projectId);
    const groupKey = groupKeyByProjectKey.get(physicalKey);
    if (!groupKey) {
      continue;
    }
    groups.get(groupKey)?.threads.push(thread);
  }

  const query = input.searchQuery.trim().toLocaleLowerCase();
  const result: HomeThreadGroup[] = [];

  for (const group of groups.values()) {
    const representative = group.projects[0];
    if (!representative || group.threads.length === 0) {
      continue;
    }

    const title =
      group.projects.length > 1
        ? deriveProjectGroupLabel({ representative, members: group.projects })
        : representative.title;
    const groupMatches =
      query.length === 0 ||
      title.toLocaleLowerCase().includes(query) ||
      group.projects.some((project) => project.title.toLocaleLowerCase().includes(query));
    const matchingThreads = groupMatches
      ? group.threads
      : group.threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query));

    if (matchingThreads.length === 0) {
      continue;
    }

    result.push({
      key: group.key,
      title,
      representative,
      projects: group.projects,
      threads: sortThreads(matchingThreads, input.threadSortOrder),
    });
  }

  return Arr.sort(
    result,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (group: HomeThreadGroup) => ({
        timestamp: groupSortTimestamp(group, input.projectSortOrder),
        title: group.title,
        key: group.key,
      }),
    ),
  );
}
