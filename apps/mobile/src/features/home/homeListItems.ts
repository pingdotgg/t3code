import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  flattenSubagentThreadTree,
  getSubagentThreadAncestorKeys,
  getSubagentThreadTreeRoots,
  subagentThreadKey,
  type SubagentThreadTreeRow,
} from "@t3tools/client-runtime/state/thread-relationships";
import type { SidebarThreadSortOrder } from "@t3tools/contracts";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { HomeThreadGroup } from "./homeThreadList";

/** Threads shown per project before the "Show more" affordance appears. */
export const HOME_INITIAL_VISIBLE_THREADS = 6;
/** Additional threads revealed per "Show more" tap. */
export const HOME_SHOW_MORE_STEP = 10;

export interface HomeGroupDisplayState {
  readonly collapsed: boolean;
  /** How many threads are currently revealed (clamped to the group size). */
  readonly visibleCount: number;
}

export const DEFAULT_GROUP_DISPLAY_STATE: HomeGroupDisplayState = {
  collapsed: false,
  visibleCount: HOME_INITIAL_VISIBLE_THREADS,
};

export interface HomeHeaderListItem {
  readonly type: "header";
  readonly key: string;
  readonly group: HomeThreadGroup;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
}

export interface HomeThreadListItem {
  readonly type: "thread";
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly depth: number;
  readonly hasSubagentChildren: boolean;
  readonly isSubagentBranchExpanded: boolean;
  readonly subagentTreeVisible: boolean;
  readonly isLast: boolean;
}

export interface HomePendingTaskListItem {
  readonly type: "pending-task";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly isLast: boolean;
}

export interface HomeShowMoreListItem {
  readonly type: "show-more";
  readonly key: string;
  readonly groupKey: string;
  /** Threads still hidden. 0 means the group is fully expanded. */
  readonly hiddenCount: number;
  /** Whether more than the initial count is revealed, so "Show less" applies. */
  readonly canShowLess: boolean;
}

export type HomeListItem =
  | HomeHeaderListItem
  | HomePendingTaskListItem
  | HomeThreadListItem
  | HomeShowMoreListItem;

export interface HomeListLayout {
  readonly items: ReadonlyArray<HomeListItem>;
  readonly stickyHeaderIndices: ReadonlyArray<number>;
}

export type HomeGroupDisplayAction = "toggle-collapsed" | "show-more" | "show-less";

export function nextGroupDisplayState(
  current: HomeGroupDisplayState,
  action: HomeGroupDisplayAction,
): HomeGroupDisplayState {
  switch (action) {
    case "toggle-collapsed":
      return { ...current, collapsed: !current.collapsed };
    case "show-more":
      return { ...current, visibleCount: current.visibleCount + HOME_SHOW_MORE_STEP };
    case "show-less":
      return { ...current, visibleCount: HOME_INITIAL_VISIBLE_THREADS };
  }
}

/**
 * Structural equality for list items. Item objects are rebuilt on every
 * collapse/show-more toggle; without this the lists would consider every
 * mounted row changed and re-render all of them (each carrying a swipeable +
 * a vcs-status subscription). Group/thread references are stable across
 * toggles.
 */
export function homeListItemsAreEqual(previous: HomeListItem, item: HomeListItem): boolean {
  switch (item.type) {
    case "header":
      return (
        previous.type === "header" &&
        previous.group === item.group &&
        previous.collapsed === item.collapsed &&
        previous.isFirst === item.isFirst
      );
    case "pending-task":
      return (
        previous.type === "pending-task" &&
        previous.pendingTask === item.pendingTask &&
        previous.isLast === item.isLast
      );
    case "thread":
      return (
        previous.type === "thread" &&
        previous.thread === item.thread &&
        previous.depth === item.depth &&
        previous.hasSubagentChildren === item.hasSubagentChildren &&
        previous.isSubagentBranchExpanded === item.isSubagentBranchExpanded &&
        previous.subagentTreeVisible === item.subagentTreeVisible &&
        previous.isLast === item.isLast
      );
    case "show-more":
      return (
        previous.type === "show-more" &&
        previous.groupKey === item.groupKey &&
        previous.hiddenCount === item.hiddenCount &&
        previous.canShowLess === item.canShowLess
      );
  }
}

export function buildHomeListLayout(input: {
  readonly groups: ReadonlyArray<HomeThreadGroup>;
  readonly displayStates: ReadonlyMap<string, HomeGroupDisplayState>;
  /**
   * When searching, pagination is suspended so every match stays visible.
   */
  readonly showAllThreads?: boolean;
  /** Enables nested, collapsible subagent rows. Disabled by default. */
  readonly showSubagentThreads?: boolean;
  readonly expandedThreadKeys?: ReadonlySet<string>;
  /**
   * Key of an explicitly selected thread that must stay reachable. In nested
   * mode, when its branch root falls past the pagination cut, that root is
   * appended so the selection never disappears from the list.
   */
  readonly pinnedThreadKey?: string | null;
  readonly threadSortOrder?: SidebarThreadSortOrder;
}): HomeListLayout {
  const items: HomeListItem[] = [];
  const stickyHeaderIndices: number[] = [];

  for (const [groupIndex, group] of input.groups.entries()) {
    const display = input.displayStates.get(group.key) ?? DEFAULT_GROUP_DISPLAY_STATE;
    const collapsed = display.collapsed && input.showAllThreads !== true;

    stickyHeaderIndices.push(items.length);
    items.push({
      type: "header",
      key: `header:${group.key}`,
      group,
      collapsed,
      isFirst: groupIndex === 0,
    });

    if (collapsed) {
      continue;
    }

    const nested = input.showSubagentThreads === true;
    // In nested mode pagination is intentionally root-based: revealing a
    // parent also reveals any expanded descendants without consuming
    // additional page slots. When the feature is off, threads stay flat and
    // subagent children paginate like any other thread.
    const paginatedThreads = nested ? getSubagentThreadTreeRoots(group.threads) : group.threads;
    const totalCount = paginatedThreads.length;
    // Default to the group's recent-activity window (last few days, or a small
    // fallback for stale projects), capped at the initial page size. Until the
    // user taps "Show more", older threads stay hidden to save vertical space;
    // "Show less" resets visibleCount to the initial constant, which lands back
    // here at the recency baseline.
    const baselineCount = Math.min(
      group.recentThreads.length,
      HOME_INITIAL_VISIBLE_THREADS,
      totalCount,
    );
    const visibleCount = input.showAllThreads
      ? totalCount
      : Math.min(
          display.visibleCount > HOME_INITIAL_VISIBLE_THREADS
            ? display.visibleCount
            : baselineCount,
          totalCount,
        );
    let visibleRoots = paginatedThreads.slice(0, visibleCount);
    if (nested && input.pinnedThreadKey != null && visibleRoots.length < totalCount) {
      // A routed selection must stay reachable: when its branch root falls
      // past the pagination cut, append that root so the branch still renders.
      const pinnedBranchKeys = new Set([
        input.pinnedThreadKey,
        ...getSubagentThreadAncestorKeys(group.threads, input.pinnedThreadKey),
      ]);
      const isPinnedRoot = (thread: EnvironmentThreadShell) =>
        pinnedBranchKeys.has(subagentThreadKey(thread));
      if (!visibleRoots.some(isPinnedRoot)) {
        const pinnedRoot = paginatedThreads.slice(visibleCount).find(isPinnedRoot);
        if (pinnedRoot !== undefined) {
          visibleRoots = [...visibleRoots, pinnedRoot];
        }
      }
    }
    const visibleThreadRows: readonly SubagentThreadTreeRow<EnvironmentThreadShell>[] = nested
      ? flattenSubagentThreadTree({
          threads: group.threads,
          roots: visibleRoots,
          // While searching, a match may sit under a collapsed parent; force
          // every branch open so matches are never invisible.
          expandedThreadKeys:
            input.showAllThreads === true
              ? new Set(group.threads.map(subagentThreadKey))
              : (input.expandedThreadKeys ?? new Set()),
          threadSortOrder: input.threadSortOrder ?? "updated_at",
        })
      : visibleRoots.map((thread) => ({
          thread,
          depth: 0,
          hasSubagentChildren: false,
          isSubagentBranchExpanded: false,
        }));
    const hiddenCount = totalCount - visibleRoots.length;
    const hasShowMoreRow = !input.showAllThreads && totalCount > baselineCount;

    // Pending (unsent) tasks lead the group and are never paginated away.
    for (const [pendingIndex, pendingTask] of group.pendingTasks.entries()) {
      items.push({
        type: "pending-task",
        key: `pending-task:${pendingTask.message.messageId}`,
        pendingTask,
        isLast:
          pendingIndex === group.pendingTasks.length - 1 &&
          visibleThreadRows.length === 0 &&
          !hasShowMoreRow,
      });
    }

    for (const [threadIndex, row] of visibleThreadRows.entries()) {
      items.push({
        type: "thread",
        key: `thread:${row.thread.environmentId}:${row.thread.id}`,
        thread: row.thread,
        depth: row.depth,
        hasSubagentChildren: row.hasSubagentChildren,
        isSubagentBranchExpanded: row.isSubagentBranchExpanded,
        subagentTreeVisible: nested,
        isLast: threadIndex === visibleThreadRows.length - 1 && !hasShowMoreRow,
      });
    }

    if (hasShowMoreRow) {
      items.push({
        type: "show-more",
        key: `show-more:${group.key}`,
        groupKey: group.key,
        hiddenCount,
        // Compare against the group's own baseline, not the global page size:
        // stale projects start below HOME_INITIAL_VISIBLE_THREADS, and "Show
        // less" must be offered as soon as anything beyond the baseline shows.
        canShowLess: visibleCount > baselineCount,
      });
    }
  }

  return { items, stickyHeaderIndices };
}
