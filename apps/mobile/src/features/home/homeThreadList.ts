import {
  deriveLogicalProjectKey,
  deriveProjectGroupLabel,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp, sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import { getSubagentThreadTreeRoots } from "@t3tools/client-runtime/state/thread-relationships";
import type {
  EnvironmentId,
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
  /**
   * Subset shown by default: threads from the last few days, or the most
   * recent few. When the nested subagent presentation is on, only tree roots
   * are counted so subagent children never consume default slots.
   */
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
  /**
   * Mirrors the nested subagent list presentation. When true, the recency
   * baseline counts only tree roots; when false (default), threads stay flat
   * and subagent children count like any other thread.
   */
  readonly showSubagentThreads?: boolean;
  /** Current time used for the recency window; defaults to now. Injectable for tests. */
  readonly now?: number;
}): ReadonlyArray<HomeThreadGroup> {
  const now = input.now ?? Date.now();
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
      groups.set(groupKey, { key: groupKey, projects: [project], pendingTasks: [], threads: [] });
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
    const recencyCandidates =
      input.showSubagentThreads === true
        ? getSubagentThreadTreeRoots(sortedThreads)
        : sortedThreads;
    const recentThreads =
      query.length === 0
        ? selectRecentThreads(recencyCandidates, input.threadSortOrder, now)
        : recencyCandidates;

    // Sorted newest-first, so the first thread whose project is a group member
    // marks the machine the user last worked on.
    const lastActiveProject = Arr.findFirst(sortedThreads, (thread) =>
      group.projects.some(
        (project) =>
          project.environmentId === thread.environmentId && project.id === thread.projectId,
      ),
    ).pipe(
      Option.flatMap((thread) =>
        Arr.findFirst(
          group.projects,
          (project) =>
            project.environmentId === thread.environmentId && project.id === thread.projectId,
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
