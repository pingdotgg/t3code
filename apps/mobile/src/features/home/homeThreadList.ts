import {
  deriveLogicalProjectKey,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  ScopedProjectRef,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

export type HomeProjectSortOrder = Exclude<SidebarProjectSortOrder, "manual">;

export interface HomeProjectScope {
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
}

function getProjectFreshnessTimestamp(project: EnvironmentProject): number {
  return toSortableTimestamp(project.updatedAt) ?? toSortableTimestamp(project.createdAt) ?? 0;
}

function getProjectSortTimestamp(
  project: EnvironmentProject,
  sortOrder: HomeProjectSortOrder,
): number {
  return sortOrder === "created_at"
    ? (toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY)
    : (toSortableTimestamp(project.updatedAt) ??
        toSortableTimestamp(project.createdAt) ??
        Number.NEGATIVE_INFINITY);
}

export function buildHomeProjectScopes(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}): ReadonlyArray<HomeProjectScope> {
  const projects = input.projects.filter(
    (project) => input.environmentId === null || project.environmentId === input.environmentId,
  );
  const projectsByPhysicalKey = new Map<string, EnvironmentProject[]>();
  for (const project of projects) {
    const physicalKey = derivePhysicalProjectKey(project);
    const existing = projectsByPhysicalKey.get(physicalKey);
    if (existing) existing.push(project);
    else projectsByPhysicalKey.set(physicalKey, [project]);
  }

  const winnersByPhysicalKey = new Map<
    string,
    { readonly key: string; readonly project: EnvironmentProject }
  >();
  for (const [physicalKey, members] of projectsByPhysicalKey) {
    const project = members.reduce((winner, candidate) => {
      const freshnessDelta =
        getProjectFreshnessTimestamp(candidate) - getProjectFreshnessTimestamp(winner);
      return freshnessDelta > 0 || (freshnessDelta === 0 && candidate.id > winner.id)
        ? candidate
        : winner;
    });
    const identitySource = members.find((member) => member.repositoryIdentity !== null) ?? project;
    winnersByPhysicalKey.set(physicalKey, {
      key: deriveLogicalProjectKey(identitySource, { groupingMode: input.projectGroupingMode }),
      project,
    });
  }

  const groups = new Map<string, EnvironmentProject[]>();
  for (const { key, project } of winnersByPhysicalKey.values()) {
    const existing = groups.get(key);
    if (existing) existing.push(project);
    else groups.set(key, [project]);
  }

  const projectRefsByGroup = new Map<string, ScopedProjectRef[]>();
  const seenProjectRefs = new Set<string>();
  for (const project of projects) {
    const refKey = scopedProjectKey(project.environmentId, project.id);
    if (seenProjectRefs.has(refKey)) continue;
    seenProjectRefs.add(refKey);

    const key =
      winnersByPhysicalKey.get(derivePhysicalProjectKey(project))?.key ??
      deriveLogicalProjectKey(project, { groupingMode: input.projectGroupingMode });
    const refs = projectRefsByGroup.get(key);
    const projectRef = { environmentId: project.environmentId, projectId: project.id };
    if (refs) refs.push(projectRef);
    else projectRefsByGroup.set(key, [projectRef]);
  }

  return Array.from(groups, ([key, projects]) => {
    const representative = projects[0]!;
    return {
      key,
      title: deriveProjectGroupLabel({ representative, members: projects }),
      representative,
      projects,
      projectRefs: projectRefsByGroup.get(key) ?? [],
    };
  });
}

export function sortHomeProjectScopes(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly projectSortOrder: HomeProjectSortOrder;
}): ReadonlyArray<HomeProjectScope> {
  const scopeKeyByProjectRef = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (projectRef) =>
          [scopedProjectKey(projectRef.environmentId, projectRef.projectId), scope.key] as const,
      ),
    ),
  );
  const latestActivityByScope = new Map<string, number>();
  const recordActivity = (scopeKey: string | undefined, timestamp: number) => {
    if (!scopeKey || !Number.isFinite(timestamp)) return;
    latestActivityByScope.set(
      scopeKey,
      Math.max(latestActivityByScope.get(scopeKey) ?? Number.NEGATIVE_INFINITY, timestamp),
    );
  };

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(thread.environmentId, thread.projectId)),
      getThreadSortTimestamp(thread, input.projectSortOrder),
    );
  }
  for (const pendingTask of input.pendingTasks) {
    recordActivity(
      scopeKeyByProjectRef.get(
        scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
      ),
      Date.parse(pendingTask.message.createdAt),
    );
  }

  return Arr.sort(
    input.scopes,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (scope: HomeProjectScope) => ({
        timestamp:
          latestActivityByScope.get(scope.key) ??
          Math.max(
            ...scope.projects.map((project) =>
              getProjectSortTimestamp(project, input.projectSortOrder),
            ),
          ),
        title: scope.title,
        key: scope.key,
      }),
    ),
  );
}

/**
 * Default home view only surfaces threads active within this window, to keep the
 * screen compact while keeping recent work visible.
 */
const RECENT_THREAD_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
/** Fallback when a project has no threads inside the recency window. */
const RECENT_THREAD_FALLBACK_COUNT = 3;

export interface HomeThreadGroup {
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  /** Full sorted thread history for the group (revealed when expanded / searching). */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Subset shown by default: threads from the last few days, or the most recent few. */
  readonly recentThreads: ReadonlyArray<EnvironmentThreadShell>;
  /**
   * Where a quick "new thread in this project" should land. For aggregated
   * groups (same repo on several machines) this is the member that owns the
   * group's most recent thread — the machine the user last worked on — rather
   * than the arbitrary first member; the draft's computer picker covers
   * switching from there. Null only for synthetic pending-project groups,
   * whose single "project" is a placeholder built from queued-task metadata.
   */
  readonly newThreadTarget: EnvironmentProject | null;
}

interface MutableHomeThreadGroup {
  readonly key: string;
  readonly projects: EnvironmentProject[];
  readonly pendingTasks: PendingNewTask[];
  readonly threads: EnvironmentThreadShell[];
}

function groupSortTimestamp(group: HomeThreadGroup, sortOrder: HomeProjectSortOrder): number {
  const latestThread = group.threads.reduce(
    (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
    Number.NEGATIVE_INFINITY,
  );
  return group.pendingTasks.reduce((latest, pendingTask) => {
    const timestamp = Date.parse(pendingTask.message.createdAt);
    return Number.isNaN(timestamp) ? latest : Math.max(latest, timestamp);
  }, latestThread);
}

/**
 * Trims a group's threads to recent activity for the default home view.
 * `sortedThreads` must already be ordered newest-first for `threadSortOrder`.
 * Keeps threads within {@link RECENT_THREAD_WINDOW_MS}; when none qualify, keeps
 * the most recent {@link RECENT_THREAD_FALLBACK_COUNT} so a project never vanishes.
 */
function selectRecentThreads(
  sortedThreads: ReadonlyArray<EnvironmentThreadShell>,
  threadSortOrder: SidebarThreadSortOrder,
  now: number,
): ReadonlyArray<EnvironmentThreadShell> {
  const cutoff = now - RECENT_THREAD_WINDOW_MS;
  const recent = sortedThreads.filter(
    (thread) => getThreadSortTimestamp(thread, threadSortOrder) >= cutoff,
  );
  return recent.length > 0 ? recent : sortedThreads.slice(0, RECENT_THREAD_FALLBACK_COUNT);
}

export function buildHomeThreadGroups(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks?: ReadonlyArray<PendingNewTask>;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  /** Current time used for the recency window; defaults to now. Injectable for tests. */
  readonly now?: number;
}): ReadonlyArray<HomeThreadGroup> {
  const now = input.now ?? Date.now();
  const groups = new Map<string, MutableHomeThreadGroup>();
  const groupKeyByProjectKey = new Map<string, string>();

  for (const scope of buildHomeProjectScopes(input)) {
    groups.set(scope.key, {
      key: scope.key,
      projects: [...scope.projects],
      pendingTasks: [],
      threads: [],
    });
    for (const projectRef of scope.projectRefs) {
      groupKeyByProjectKey.set(
        scopedProjectKey(projectRef.environmentId, projectRef.projectId),
        scope.key,
      );
    }
  }

  for (const pendingTask of input.pendingTasks ?? []) {
    if (input.environmentId !== null && pendingTask.message.environmentId !== input.environmentId) {
      continue;
    }

    const physicalKey = scopedProjectKey(
      pendingTask.message.environmentId,
      pendingTask.creation.projectId,
    );
    let groupKey = groupKeyByProjectKey.get(physicalKey);
    if (!groupKey) {
      // The project shell is not loaded (environment offline / project gone).
      // A queued task must stay visible and deletable regardless, so build a
      // standalone group from the metadata snapshotted at enqueue time.
      groupKey = `pending-project:${physicalKey}`;
      groupKeyByProjectKey.set(physicalKey, groupKey);
      groups.set(groupKey, {
        key: groupKey,
        projects: [
          {
            environmentId: pendingTask.message.environmentId,
            id: pendingTask.creation.projectId,
            title: pendingTask.creation.projectTitle ?? "Unknown project",
            workspaceRoot:
              pendingTask.creation.projectCwd ?? String(pendingTask.creation.projectId),
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: pendingTask.message.createdAt,
            updatedAt: pendingTask.message.createdAt,
          },
        ],
        pendingTasks: [],
        threads: [],
      });
    }
    groups.get(groupKey)?.pendingTasks.push(pendingTask);
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
    if (!representative || (group.threads.length === 0 && group.pendingTasks.length === 0)) {
      continue;
    }

    const title = deriveProjectGroupLabel({ representative, members: group.projects });
    const groupMatches =
      query.length === 0 ||
      title.toLocaleLowerCase().includes(query) ||
      group.projects.some((project) => project.title.toLocaleLowerCase().includes(query));
    const matchingThreads = groupMatches
      ? group.threads
      : group.threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query));
    const matchingPendingTasks = groupMatches
      ? group.pendingTasks
      : group.pendingTasks.filter((pendingTask) =>
          pendingTask.title.toLocaleLowerCase().includes(query),
        );

    if (matchingThreads.length === 0 && matchingPendingTasks.length === 0) {
      continue;
    }

    const sortedThreads = sortThreads(matchingThreads, input.threadSortOrder);
    // An active search should reach the full history, so the recency window
    // only trims the default (no-query) view.
    const recentThreads =
      query.length === 0
        ? selectRecentThreads(sortedThreads, input.threadSortOrder, now)
        : sortedThreads;

    // A stale project id still resolves to the canonical member with the same
    // environment/path, so quick creation follows the machine with the newest activity.
    const lastActiveProject = Arr.head(sortedThreads).pipe(
      Option.flatMap((thread) =>
        Arr.findFirst(
          input.projects,
          (project) =>
            project.environmentId === thread.environmentId && project.id === thread.projectId,
        ),
      ),
      Option.flatMap((threadProject) =>
        Arr.findFirst(
          group.projects,
          (project) =>
            derivePhysicalProjectKey(project) === derivePhysicalProjectKey(threadProject),
        ),
      ),
      Option.getOrNull,
    );

    result.push({
      key: group.key,
      title,
      representative,
      projects: group.projects,
      pendingTasks: matchingPendingTasks,
      threads: sortedThreads,
      recentThreads,
      newThreadTarget: group.key.startsWith("pending-project:")
        ? null
        : (lastActiveProject ?? representative),
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
