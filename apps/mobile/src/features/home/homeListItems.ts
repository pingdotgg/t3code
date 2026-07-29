import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { HomeThreadGroup } from "./homeThreadList";

/** Threads shown per project before the "Show more" affordance appears. */
export const HOME_INITIAL_VISIBLE_THREADS = 6;
/** Additional threads revealed per "Show more" tap. */
export const HOME_SHOW_MORE_STEP = 10;
/**
 * Settled tail paging (upstream Thread List v2 parity): recent settled
 * history is the common lookup, so it renders immediately once the
 * disclosure opens; the deep tail stays behind an explicit "Show more".
 */
export const HOME_SETTLED_INITIAL_COUNT = 10;
/** Additional settled threads revealed per "Show more" tap. */
export const HOME_SETTLED_PAGE_COUNT = 25;

export interface HomeGroupDisplayState {
  readonly collapsed: boolean;
  /** How many threads are currently revealed (clamped to the group size). */
  readonly visibleCount: number;
  /** Whether the group's settled-thread disclosure is open (mac parity). */
  readonly settledRevealed: boolean;
  /** How many settled threads are currently revealed once the disclosure is open. */
  readonly settledVisibleCount: number;
}

export const DEFAULT_GROUP_DISPLAY_STATE: HomeGroupDisplayState = {
  collapsed: false,
  visibleCount: HOME_INITIAL_VISIBLE_THREADS,
  settledRevealed: false,
  settledVisibleCount: HOME_SETTLED_INITIAL_COUNT,
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

export interface HomeSettledToggleListItem {
  readonly type: "settled-toggle";
  readonly key: string;
  readonly groupKey: string;
  readonly settledCount: number;
  readonly revealed: boolean;
}

export interface HomeSettledShowMoreListItem {
  readonly type: "settled-show-more";
  readonly key: string;
  readonly groupKey: string;
  /** Settled threads still hidden beyond the current page. */
  readonly hiddenCount: number;
}

export type HomeListItem =
  | HomeHeaderListItem
  | HomePendingTaskListItem
  | HomeThreadListItem
  | HomeShowMoreListItem
  | HomeSettledToggleListItem
  | HomeSettledShowMoreListItem;

export interface HomeListLayout {
  readonly items: ReadonlyArray<HomeListItem>;
  readonly stickyHeaderIndices: ReadonlyArray<number>;
}

export type HomeGroupDisplayAction =
  | "toggle-collapsed"
  | "show-more"
  | "show-less"
  | "toggle-settled"
  | "show-more-settled";

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
    case "toggle-settled":
      return { ...current, settledRevealed: !current.settledRevealed };
    case "show-more-settled":
      return {
        ...current,
        settledVisibleCount: current.settledVisibleCount + HOME_SETTLED_PAGE_COUNT,
      };
  }
}

/**
 * Resets every group's settled-tail paging back to the initial page. Called
 * when the project scope (environment filter) or search query changes so a
 * deep "Show more" page never carries over into an unrelated filter context.
 */
export function resetSettledVisibleCounts(
  states: ReadonlyMap<string, HomeGroupDisplayState>,
): ReadonlyMap<string, HomeGroupDisplayState> {
  const next = new Map<string, HomeGroupDisplayState>();
  for (const [key, state] of states) {
    next.set(key, { ...state, settledVisibleCount: HOME_SETTLED_INITIAL_COUNT });
  }
  return next;
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
        previous.isLast === item.isLast
      );
    case "show-more":
      return (
        previous.type === "show-more" &&
        previous.groupKey === item.groupKey &&
        previous.hiddenCount === item.hiddenCount &&
        previous.canShowLess === item.canShowLess
      );
    case "settled-toggle":
      return (
        previous.type === "settled-toggle" &&
        previous.groupKey === item.groupKey &&
        previous.settledCount === item.settledCount &&
        previous.revealed === item.revealed
      );
    case "settled-show-more":
      return (
        previous.type === "settled-show-more" &&
        previous.groupKey === item.groupKey &&
        previous.hiddenCount === item.hiddenCount
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

    const totalCount = group.threads.length;
    const visibleCount = input.showAllThreads
      ? totalCount
      : Math.min(Math.max(display.visibleCount, HOME_INITIAL_VISIBLE_THREADS), totalCount);
    const visibleThreads = group.threads.slice(0, visibleCount);
    const hiddenCount = totalCount - visibleCount;
    const hasShowMoreRow = !input.showAllThreads && totalCount > HOME_INITIAL_VISIBLE_THREADS;
    const hasSettledRow = group.settledThreads.length > 0;

    // Pending (unsent) tasks lead the group and are never paginated away.
    for (const [pendingIndex, pendingTask] of group.pendingTasks.entries()) {
      items.push({
        type: "pending-task",
        key: `pending-task:${pendingTask.message.messageId}`,
        pendingTask,
        isLast:
          pendingIndex === group.pendingTasks.length - 1 &&
          visibleThreads.length === 0 &&
          !hasShowMoreRow &&
          !hasSettledRow,
      });
    }

    for (const [threadIndex, thread] of visibleThreads.entries()) {
      items.push({
        type: "thread",
        key: `thread:${thread.environmentId}:${thread.id}`,
        thread,
        isLast: threadIndex === visibleThreads.length - 1 && !hasShowMoreRow && !hasSettledRow,
      });
    }

    if (hasShowMoreRow) {
      items.push({
        type: "show-more",
        key: `show-more:${group.key}`,
        groupKey: group.key,
        hiddenCount,
        canShowLess: visibleCount > HOME_INITIAL_VISIBLE_THREADS,
      });
    }

    // Settled threads leave the inbox but stay reachable behind a per-group
    // disclosure (mac parity), most recently settled first. The revealed tail
    // pages in behind its own "Show more" so a project with a long settled
    // history doesn't build hundreds of hidden rows at once.
    if (group.settledThreads.length > 0) {
      const settledRevealed = display.settledRevealed;
      items.push({
        type: "settled-toggle",
        key: `settled-toggle:${group.key}`,
        groupKey: group.key,
        settledCount: group.settledThreads.length,
        revealed: settledRevealed,
      });
      if (settledRevealed) {
        const settledTotalCount = group.settledThreads.length;
        const settledVisibleCount = input.showAllThreads
          ? settledTotalCount
          : Math.min(
              Math.max(display.settledVisibleCount, HOME_SETTLED_INITIAL_COUNT),
              settledTotalCount,
            );
        const visibleSettledThreads = group.settledThreads.slice(0, settledVisibleCount);
        const settledHiddenCount = settledTotalCount - visibleSettledThreads.length;
        const hasSettledShowMoreRow = !input.showAllThreads && settledHiddenCount > 0;
        for (const [settledIndex, thread] of visibleSettledThreads.entries()) {
          items.push({
            type: "thread",
            key: `thread:${thread.environmentId}:${thread.id}`,
            thread,
            isLast: settledIndex === visibleSettledThreads.length - 1 && !hasSettledShowMoreRow,
          });
        }
        if (hasSettledShowMoreRow) {
          items.push({
            type: "settled-show-more",
            key: `settled-show-more:${group.key}`,
            groupKey: group.key,
            hiddenCount: settledHiddenCount,
          });
        }
      }
    }
  }

  return { items, stickyHeaderIndices };
}
