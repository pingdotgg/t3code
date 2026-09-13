import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  groupThreadsByTask,
  partitionTaskMembers,
  rollupTaskStatus,
  taskShelf,
  taskOrderRow,
  threadOrderRow,
  sortTaskRowsByOrderKey,
  type TaskMemberStatus,
} from "@t3tools/client-runtime/state/task-grouping";
import { sortActiveThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { effectiveSnoozed, snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import type { ThreadListV2ListItem } from "./threadListV2";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

export type MobileTaskListItem =
  | (({ readonly type: "task-card" } | { readonly type: "task-slim" }) & {
      readonly key: string;
      readonly task: EnvironmentTask;
      readonly expanded: boolean;
      readonly count: number;
      readonly selected?: boolean;
      readonly snoozed?: boolean;
      readonly status: TaskMemberStatus;
    })
  | {
      readonly type: "task-subshelf-header";
      readonly key: string;
      readonly task: EnvironmentTask;
      readonly expanded: boolean;
      readonly count: number;
    }
  | { readonly type: "task-new-thread"; readonly key: string; readonly task: EnvironmentTask };

export function mobileTaskKey(task: Pick<EnvironmentTask, "environmentId" | "id">) {
  return `${task.environmentId}:${task.id}`;
}

/** Task children stay contiguous; only container rows participate in the shared top-level order. */
export function buildMobileTaskListItems(input: {
  readonly items: readonly ThreadListV2ListItem[];
  readonly tasks: readonly EnvironmentTask[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly pendingTasks: readonly PendingNewTask[];
  readonly capableIds: ReadonlySet<EnvironmentId>;
  readonly collapsedTaskKeys: ReadonlySet<string>;
  readonly expandedTaskShelfKeys: ReadonlySet<string>;
  readonly environmentId: EnvironmentId | null;
  readonly projectScoped: boolean;
  readonly ungroupedLayout?: boolean;
  readonly searchQuery: string;
  readonly selectedTaskKey?: string | null;
  readonly selectedThreadKey?: string | null;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly now: string;
}): ThreadListV2ListItem[] {
  if (input.projectScoped) return [...input.items];
  const groups = groupThreadsByTask({
    tasks: input.tasks,
    threads: input.threads,
    taskCapableEnvironmentIds: input.capableIds,
  });
  const taskKeys = new Set(groups.tasks.map(mobileTaskKey));
  const memberOfKnownTask = (thread: { environmentId: EnvironmentId; taskId?: string | null }) =>
    thread.taskId != null && taskKeys.has(`${thread.environmentId}:${thread.taskId}`);
  const remaining = input.items.filter((item) =>
    item.type === "v2-thread"
      ? !memberOfKnownTask(item.item.thread)
      : item.type === "v2-pending"
        ? !memberOfKnownTask(item.pendingTask)
        : true,
  );
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const matches = (thread: EnvironmentThreadShell) =>
    !query ||
    thread.title.toLocaleLowerCase().includes(query) ||
    threadPullRequestSearchTerms(thread).some((term) => term.toLocaleLowerCase().includes(query)) ||
    input.matchedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true;
  const pendingByTask = new Map<string, PendingNewTask[]>();
  for (const pending of input.pendingTasks) {
    if (pending.taskId == null) continue;
    const key = `${pending.environmentId}:${pending.taskId}`;
    const group = pendingByTask.get(key);
    if (group) group.push(pending);
    else pendingByTask.set(key, [pending]);
  }
  const blocks = new Map<string, ThreadListV2ListItem[]>();
  const orderedRows = {
    pinned: [] as ReturnType<typeof taskOrderRow>[],
    active: [] as ReturnType<typeof taskOrderRow>[],
  };
  const parked: ThreadListV2ListItem[] = [];
  for (const task of groups.tasks) {
    if (input.environmentId !== null && input.environmentId !== task.environmentId) continue;
    const key = mobileTaskKey(task);
    const members = groups.membersByTaskKey.get(key) ?? [];
    const pending = pendingByTask.get(key) ?? [];
    const taskMatches =
      !query ||
      task.name.toLocaleLowerCase().includes(query) ||
      task.description?.toLocaleLowerCase().includes(query);
    if (
      !taskMatches &&
      !members.some(matches) &&
      !pending.some((item) => item.title.toLocaleLowerCase().includes(query))
    )
      continue;
    const partition = partitionTaskMembers(members, input);
    const selectedMember = members.some(
      (thread) => `${thread.environmentId}:${thread.id}` === input.selectedThreadKey,
    );
    const queued =
      pending.length > 0 ||
      members.some((thread) => input.queuedThreadKeys.has(`${thread.environmentId}:${thread.id}`));
    const shelf = queued ? (task.pinnedAt ? "pinned" : "active") : taskShelf(task, input.now);
    const expanded =
      query.length > 0 ||
      selectedMember ||
      queued ||
      (shelf === "active" || shelf === "pinned"
        ? !input.collapsedTaskKeys.has(key)
        : input.collapsedTaskKeys.has(`parked:${key}`));
    const block: ThreadListV2ListItem[] = [
      {
        type: shelf === "active" || shelf === "pinned" ? "task-card" : "task-slim",
        key: `task:${key}`,
        task,
        expanded,
        count: members.length + pending.length,
        selected: key === input.selectedTaskKey,
        snoozed: shelf === "snoozed",
        status: rollupTaskStatus(partition.live),
      },
    ];
    const addMember = (thread: EnvironmentThreadShell, slim: boolean, snoozed: boolean) => {
      if (!taskMatches && !matches(thread)) return;
      block.push({
        type: "v2-thread",
        key: `v2-thread:${thread.environmentId}:${thread.id}`,
        item: {
          taskMember: true,
          thread,
          variant: slim ? "slim" : "card",
          snoozed,
          pinned: false,
          isLast: false,
        },
        snoozeWakeLabelText:
          snoozed && thread.snoozedUntil != null
            ? snoozeWakeLabel(thread.snoozedUntil, { now: input.now })
            : undefined,
      });
    };
    if (expanded) {
      for (const thread of sortActiveThreadsByOrderKey(partition.live))
        addMember(thread, false, false);
      for (const thread of partition.snoozed) addMember(thread, true, true);
      for (const pendingTask of pending.filter(
        (item) => taskMatches || item.title.toLocaleLowerCase().includes(query),
      ))
        block.push({
          type: "v2-pending",
          key: `v2-${pendingTask.key}`,
          pendingTask,
          showPendingDivider: false,
        });
      block.push({ type: "task-new-thread", key: `task-new:${key}`, task });
      if (partition.settled.length > 0) {
        const shelfExpanded =
          !!query ||
          input.expandedTaskShelfKeys.has(key) ||
          partition.settled.some(
            (thread) => `${thread.environmentId}:${thread.id}` === input.selectedThreadKey,
          );
        block.push({
          type: "task-subshelf-header",
          key: `task-settled:${key}`,
          task,
          count: partition.settled.length,
          expanded: shelfExpanded,
        });
        if (shelfExpanded)
          for (const thread of [...partition.settled].sort((a, b) =>
            (b.settledAt ?? b.updatedAt).localeCompare(a.settledAt ?? a.updatedAt),
          ))
            addMember(thread, true, false);
      }
    }
    if (shelf === "pinned" || shelf === "active") {
      const row = taskOrderRow(task);
      orderedRows[shelf].push(row);
      blocks.set(row.id, block);
    } else parked.push(...block);
  }
  const tail: ThreadListV2ListItem[] = [];
  for (const item of remaining) {
    if (item.type === "v2-thread" && item.item.variant === "card") {
      const row = threadOrderRow(item.item.thread);
      orderedRows[item.item.pinned ? "pinned" : "active"].push(row);
      blocks.set(row.id, [item]);
    } else if (item.type === "v2-snoozed-shelf" || item.type === "v2-settled-shelf") {
      const snoozed = item.type === "v2-snoozed-shelf";
      const removedCount = input.ungroupedLayout
        ? 0
        : input.threads.filter(
            (thread) =>
              memberOfKnownTask(thread) &&
              (input.environmentId === null || thread.environmentId === input.environmentId) &&
              matches(thread) &&
              (snoozed
                ? effectiveSnoozed(thread, input)
                : !effectiveSnoozed(thread, input) && thread.settledOverride === "settled"),
          ).length;
      if (item.count > removedCount) tail.push({ ...item, count: item.count - removedCount });
    } else tail.push(item);
  }
  return [
    ...(["pinned", "active"] as const).flatMap((shelf) =>
      sortTaskRowsByOrderKey(orderedRows[shelf], shelf).flatMap((row) => blocks.get(row.id) ?? []),
    ),
    ...parked,
    ...tail,
  ];
}
