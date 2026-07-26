import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

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
  /** Whether the group's settled-thread disclosure is open (mac parity). */
  readonly settledRevealed: boolean;
}

export const DEFAULT_GROUP_DISPLAY_STATE: HomeGroupDisplayState = {
  collapsed: false,
  visibleCount: HOME_INITIAL_VISIBLE_THREADS,
  settledRevealed: false,
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
  /**
   * The group's settled threads, so the row's archive-all action can act on
   * them without the screen re-deriving the group from its key. A group can
   * span environments, so the batch carries each thread's own environment id.
   */
  readonly settledThreads: ReadonlyArray<EnvironmentThreadShell>;
}

export type HomeListItem =
  | HomeHeaderListItem
  | HomePendingTaskListItem
  | HomeThreadListItem
  | HomeShowMoreListItem
  | HomeSettledToggleListItem;

export interface HomeListLayout {
  readonly items: ReadonlyArray<HomeListItem>;
  readonly stickyHeaderIndices: ReadonlyArray<number>;
}

export type HomeGroupDisplayAction =
  | "toggle-collapsed"
  | "show-more"
  | "show-less"
  | "toggle-settled";

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
        previous.revealed === item.revealed &&
        previous.settledThreads === item.settledThreads
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
    // disclosure (mac parity), most recently settled first.
    if (group.settledThreads.length > 0) {
      const settledRevealed = display.settledRevealed;
      items.push({
        type: "settled-toggle",
        key: `settled-toggle:${group.key}`,
        groupKey: group.key,
        settledCount: group.settledThreads.length,
        revealed: settledRevealed,
        settledThreads: group.settledThreads,
      });
      if (settledRevealed) {
        for (const [settledIndex, thread] of group.settledThreads.entries()) {
          items.push({
            type: "thread",
            key: `thread:${thread.environmentId}:${thread.id}`,
            thread,
            isLast: settledIndex === group.settledThreads.length - 1,
          });
        }
      }
    }
  }

  return { items, stickyHeaderIndices };
}
