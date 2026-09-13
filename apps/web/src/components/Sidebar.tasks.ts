import type {
  EnvironmentId,
  ProjectId,
  ScopedTaskRef,
  ScopedThreadRef,
  TaskId,
} from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedTaskKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeTaskRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  groupThreadsByTask,
  partitionTaskMembers,
  planTaskRowReorder,
  rollupTaskStatus,
  sortTaskRowsByOrderKey,
  taskOrderRow,
  taskShelf,
  taskSettleBlocker,
  taskMatchesSearch,
  taskHasLocalWork,
  taskMemberHasLocalWork,
  resolveTaskPresentation,
  taskChildVisible,
  threadOrderRow,
  type TaskGroupingTask,
  type TaskMemberStatus,
  type TaskOrderRow,
} from "@t3tools/client-runtime/state/task-grouping";
import {
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { snoozeWakeLabel } from "./Sidebar.snooze";
import { sidebarMarkerId, type SidebarListMarker, type SidebarSection } from "./Sidebar.logic";

export interface TaskSidebarDraft {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId?: TaskId | null;
  readonly title?: string;
}

export type TaskSidebarItem =
  | { readonly kind: "marker"; readonly marker: SidebarListMarker }
  | {
      readonly kind: "task";
      readonly key: string;
      readonly taskKey: string;
      readonly taskRef: ScopedTaskRef;
      readonly section: SidebarSection;
      readonly expanded: boolean;
      readonly counts: {
        readonly live: number;
        readonly snoozed: number;
        readonly settled: number;
      };
      readonly status: TaskMemberStatus;
      readonly settleBlocked: boolean;
      readonly timeLabel: string;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly threadRef: ScopedThreadRef;
      readonly section: SidebarSection;
      readonly taskKey?: string;
      readonly slim?: boolean;
    }
  | {
      readonly kind: "draft";
      readonly key: string;
      readonly draft: TaskSidebarDraft;
      readonly section: "active";
      readonly taskKey?: string;
    }
  | {
      readonly kind: "task-new-thread";
      readonly key: string;
      readonly taskKey: string;
      readonly taskRef: ScopedTaskRef;
    }
  | {
      readonly kind: "task-settled-header";
      readonly key: string;
      readonly taskKey: string;
      readonly taskRef: ScopedTaskRef;
      readonly count: number;
      readonly expanded: boolean;
    };

export function taskSidebarItemId(item: TaskSidebarItem) {
  return item.kind === "marker" ? sidebarMarkerId(item.marker) : item.key;
}

export interface TaskSidebarGroup {
  readonly task: TaskGroupingTask;
  readonly latestActivityAt: string;
  readonly live: readonly EnvironmentThreadShell[];
  readonly snoozed: readonly EnvironmentThreadShell[];
  readonly settled: readonly EnvironmentThreadShell[];
}

/** One ordered inventory owns rendering, guide lines and drag blocks, including structural rows. */
export function buildTaskSidebarInventory(input: {
  readonly tasks: readonly TaskGroupingTask[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly taskCapableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly now: string;
  readonly projectScope?: ReadonlySet<string> | null;
  readonly search?: string;
  readonly matchingThreadKeys?: ReadonlySet<string>;
  readonly selectedThreadKey?: string | null;
  readonly selectedDraftKey?: string | null;
  readonly selectedTaskKey?: string | null;
  readonly collapsedTaskKeys?: ReadonlySet<string>;
  readonly expandedTaskKeys?: ReadonlySet<string>;
  readonly expandedSettledTaskKeys?: ReadonlySet<string>;
  readonly drafts?: readonly TaskSidebarDraft[];
  readonly queuedThreadKeys?: ReadonlySet<string>;
  readonly snoozedExpanded?: boolean;
  readonly settledExpanded?: boolean;
  readonly settledVisibleCount?: number;
  readonly threadSettlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly threadSnoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
}) {
  const grouped = groupThreadsByTask(input);
  const query = input.search?.trim().toLocaleLowerCase() ?? "";
  const searching = query.length > 0;
  const keyForThread = (thread: EnvironmentThreadShell) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const matchesThread = (thread: EnvironmentThreadShell) =>
    !searching ||
    thread.title.toLocaleLowerCase().includes(query) ||
    threadPullRequestSearchTerms(thread).some((term) => term.toLocaleLowerCase().includes(query)) ||
    input.matchingThreadKeys?.has(keyForThread(thread)) === true;
  const selectedThread = (thread: EnvironmentThreadShell) =>
    keyForThread(thread) === input.selectedThreadKey;
  const groupsByTaskKey = new Map<string, TaskSidebarGroup>();
  const blocks = new Map<string, TaskSidebarItem[]>();
  const orderRows: TaskOrderRow[] = [];
  const visibleRows: Record<SidebarSection, TaskOrderRow[]> = {
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
  };
  const draftsByTask = new Map<string, TaskSidebarDraft[]>();
  const flatDrafts: TaskSidebarDraft[] = [];
  const taskKeys = new Set(
    grouped.tasks.map((task) => scopedTaskKey(scopeTaskRef(task.environmentId, task.id))),
  );
  for (const draft of input.drafts ?? []) {
    if (
      input.projectScope != null &&
      !input.projectScope.has(
        scopedProjectKey(scopeProjectRef(draft.environmentId, draft.projectId)),
      )
    )
      continue;
    const taskKey =
      draft.taskId == null
        ? undefined
        : scopedTaskKey(scopeTaskRef(draft.environmentId, draft.taskId));
    if (taskKey && taskKeys.has(taskKey)) {
      const members = draftsByTask.get(taskKey) ?? [];
      members.push(draft);
      draftsByTask.set(taskKey, members);
    } else flatDrafts.push(draft);
  }
  const threadRow = (
    thread: EnvironmentThreadShell,
    section: SidebarSection,
    taskKey?: string,
  ): TaskSidebarItem => ({
    kind: "thread",
    key: keyForThread(thread),
    threadRef: scopeThreadRef(thread.environmentId, thread.id),
    section,
    ...(taskKey ? { taskKey } : {}),
  });
  const sortMembers = (
    members: readonly EnvironmentThreadShell[],
    section: "active" | "snoozed" | "settled",
  ) =>
    section === "settled"
      ? [...members].sort(
          (a, b) =>
            (resolveSettledThreadTimestamp(b) ?? "").localeCompare(
              resolveSettledThreadTimestamp(a) ?? "",
            ) || keyForThread(a).localeCompare(keyForThread(b)),
        )
      : sortActiveThreadsByOrderKey(members);

  for (const task of grouped.tasks) {
    const taskRef = scopeTaskRef(task.environmentId, task.id);
    const taskKey = scopedTaskKey(taskRef);
    const orderRow = taskOrderRow(task);
    const taskMembers = grouped.membersByTaskKey.get(taskKey) ?? [];
    const partition = partitionTaskMembers(taskMembers, input);
    const group = {
      task,
      latestActivityAt: taskMembers.reduce(
        (latest, member) => (member.updatedAt > latest ? member.updatedAt : latest),
        task.updatedAt,
      ),
      live: sortMembers(partition.live, "active"),
      snoozed: sortMembers(partition.snoozed, "snoozed"),
      settled: sortMembers(partition.settled, "settled"),
    };
    groupsByTaskKey.set(taskKey, group);
    orderRows.push(orderRow);
    const drafts = draftsByTask.get(taskKey) ?? [];
    const members = [...group.live, ...group.snoozed, ...group.settled];
    const selected =
      members.some(selectedThread) ||
      input.selectedTaskKey === taskKey ||
      drafts.some((draft) => draft.key === input.selectedDraftKey);
    const hasLocalWork = taskHasLocalWork({ ...input, members, pendingCount: drafts.length });
    const matchingDrafts = drafts.filter(
      (draft) => !searching || draft.title?.toLocaleLowerCase().includes(query),
    );
    if (
      searching &&
      !taskMatchesSearch(task, query) &&
      !members.some(matchesThread) &&
      !matchingDrafts.length &&
      !selected &&
      !hasLocalWork
    )
      continue;
    const effectiveShelf = hasLocalWork
      ? task.pinnedAt
        ? "pinned"
        : "active"
      : taskShelf(task, input.now);
    const { shelf: section, expanded } = resolveTaskPresentation({
      task,
      now: input.now,
      hasLocalWork,
      collapsed: !(
        input.expandedTaskKeys?.has(taskKey) === true ||
        ((effectiveShelf === "active" || effectiveShelf === "pinned") &&
          input.collapsedTaskKeys?.has(taskKey) !== true)
      ),
      searching,
      hasMatchingChildren: members.some(matchesThread) || matchingDrafts.length > 0,
    });
    const parked = section === "snoozed" || section === "settled";
    const block: TaskSidebarItem[] = [
      {
        kind: "task",
        key: orderRow.id,
        taskKey,
        taskRef,
        section,
        expanded,
        counts: {
          live: group.live.length,
          snoozed: group.snoozed.length,
          settled: group.settled.length,
        },
        status: rollupTaskStatus(group.live),
        settleBlocked: taskSettleBlocker(members, input) !== null,
        timeLabel:
          section === "snoozed" && task.snoozedUntil
            ? snoozeWakeLabel(task.snoozedUntil, { now: input.now })
            : formatRelativeTimeLabel(
                section === "settled" ? (task.settledAt ?? task.updatedAt) : group.latestActivityAt,
                Date.parse(input.now),
              ),
      },
    ];
    const visibleMember = (thread: EnvironmentThreadShell) =>
      taskChildVisible({
        expanded,
        matches: matchesThread(thread),
        selected: selectedThread(thread),
        pending: taskMemberHasLocalWork(thread, input),
      });
    for (const thread of group.live.filter(visibleMember))
      block.push(threadRow(thread, "active", taskKey));
    for (const thread of group.snoozed.filter(visibleMember))
      block.push(threadRow(thread, "snoozed", taskKey));
    block.push(
      ...drafts.map((draft): TaskSidebarItem => ({
        kind: "draft",
        key: draft.key,
        draft,
        section: "active",
        taskKey,
      })),
    );
    if (expanded && !parked) {
      block.push({ kind: "task-new-thread", key: `${orderRow.id}:new-thread`, taskKey, taskRef });
    }
    const settledExpanded =
      parked || searching || input.expandedSettledTaskKeys?.has(taskKey) === true;
    const settled = group.settled.filter((thread) =>
      taskChildVisible({
        expanded: expanded && settledExpanded,
        matches: matchesThread(thread),
        selected: selectedThread(thread),
        pending: taskMemberHasLocalWork(thread, input),
      }),
    );
    if ((expanded && group.settled.length > 0) || settled.length > 0) {
      if (!parked)
        block.push({
          kind: "task-settled-header",
          key: `${orderRow.id}:settled`,
          taskKey,
          taskRef,
          count: group.settled.length,
          expanded: settledExpanded,
        });
      block.push(...settled.map((thread) => threadRow(thread, "settled", taskKey)));
    }
    blocks.set(
      orderRow.id,
      section === "snoozed" || section === "settled"
        ? block.map((item) => (item.kind === "thread" ? { ...item, slim: true } : item))
        : block,
    );
    visibleRows[section].push(orderRow);
  }
  for (const thread of grouped.ungrouped) {
    const row = threadOrderRow(thread);
    orderRows.push(row);
    if (!matchesThread(thread) && !selectedThread(thread)) continue;
    const supportedThread = {
      ...thread,
      ...(input.threadSettlementEnvironmentIds &&
      !input.threadSettlementEnvironmentIds.has(thread.environmentId)
        ? { settledOverride: null }
        : {}),
      ...(input.threadSnoozeEnvironmentIds &&
      !input.threadSnoozeEnvironmentIds.has(thread.environmentId)
        ? { snoozedUntil: null }
        : {}),
    };
    const partition = partitionTaskMembers([supportedThread], input);
    const section = partition.snoozed.length
      ? "snoozed"
      : partition.settled.length
        ? "settled"
        : thread.pinnedAt
          ? "pinned"
          : "active";
    blocks.set(row.id, [threadRow(thread, section)]);
    visibleRows[section].push(row);
  }
  visibleRows.pinned = sortTaskRowsByOrderKey(visibleRows.pinned, "pinned");
  visibleRows.active = sortTaskRowsByOrderKey(visibleRows.active, "active");
  const parkedTime = (row: TaskOrderRow) =>
    row.kind === "task"
      ? (row.entity.settledAt ?? row.entity.updatedAt)
      : (resolveSettledThreadTimestamp(row.entity) ?? "");
  visibleRows.settled.sort(
    (a, b) => parkedTime(b).localeCompare(parkedTime(a)) || a.id.localeCompare(b.id),
  );
  visibleRows.snoozed.sort(
    (a, b) =>
      (a.entity.snoozedUntil ?? "").localeCompare(b.entity.snoozedUntil ?? "") ||
      a.id.localeCompare(b.id),
  );
  const items: TaskSidebarItem[] = [];
  const marker = (name: SidebarListMarker) => items.push({ kind: "marker", marker: name });
  const selectedBlock = (row: TaskOrderRow) =>
    blocks
      .get(row.id)
      ?.some(
        (item) =>
          (item.kind === "thread" && item.key === input.selectedThreadKey) ||
          (item.kind === "task" && item.taskKey === input.selectedTaskKey) ||
          (item.kind === "draft" && item.key === input.selectedDraftKey),
      ) === true;
  const append = (rows: readonly TaskOrderRow[], retainedOnly = false) => {
    for (const row of rows)
      items.push(
        ...blocks
          .get(row.id)!
          .filter(
            (item) =>
              !retainedOnly ||
              item.kind === "task" ||
              (item.kind === "thread" && item.key === input.selectedThreadKey) ||
              (item.kind === "draft" && item.key === input.selectedDraftKey),
          ),
      );
  };
  marker("pinned-header");
  append(visibleRows.pinned);
  marker("pinned-divider");
  items.push(
    ...flatDrafts
      .filter(
        (draft) =>
          !searching ||
          draft.title?.toLocaleLowerCase().includes(query) ||
          draft.key === input.selectedDraftKey,
      )
      .map((draft): TaskSidebarItem => ({
        kind: "draft",
        key: draft.key,
        draft,
        section: "active",
      })),
  );
  append(visibleRows.active);
  if (!visibleRows.active.length) marker("active-placeholder");
  if (visibleRows.snoozed.length) {
    marker("snoozed-header");
    append(
      visibleRows.snoozed.filter(
        (row) => searching || input.snoozedExpanded === true || selectedBlock(row),
      ),
      !searching && input.snoozedExpanded !== true,
    );
  }
  marker("settled-header");
  let visibleSettledCount = 0;
  for (const [index, row] of visibleRows.settled.entries()) {
    const showFull =
      searching ||
      (input.settledExpanded === true && index < (input.settledVisibleCount ?? Infinity));
    if (!showFull && !selectedBlock(row)) continue;
    append([row], !showFull);
    visibleSettledCount += 1;
  }
  if (!visibleSettledCount) marker("settled-placeholder");
  return {
    items,
    orderRows,
    groupsByTaskKey,
    counts: {
      pinned: visibleRows.pinned.length,
      active: visibleRows.active.length,
      snoozed: visibleRows.snoozed.length,
      settled: visibleRows.settled.length,
    },
  };
}

type MovableTaskSidebarItem = Extract<TaskSidebarItem, { kind: "task" | "thread" }>;
export type TaskSidebarDrop =
  | {
      readonly kind: "move-to-task";
      readonly threadRef: ScopedThreadRef;
      readonly taskRef: ScopedTaskRef;
    }
  | {
      readonly kind: "remove-from-task";
      readonly threadRef: ScopedThreadRef;
      readonly section: "active";
    }
  | {
      readonly kind: "reorder";
      readonly source: MovableTaskSidebarItem;
      readonly section: "pinned" | "active" | "settled";
      readonly order: readonly string[];
      readonly taskKey?: string;
    };

/** Card centers accept membership; before/after slots reorder whole top-level blocks. */
export function resolveTaskSidebarDrop(
  items: readonly TaskSidebarItem[],
  sourceKey: string,
  targetKey: string,
  placement: "on" | "before" | "after" = "on",
): TaskSidebarDrop | null {
  const source = items.find((item) => taskSidebarItemId(item) === sourceKey);
  const target = items.find((item) => taskSidebarItemId(item) === targetKey);
  if (
    !source ||
    !target ||
    (source.kind !== "task" && source.kind !== "thread") ||
    sourceKey === targetKey
  )
    return null;
  if (target.kind === "task" && placement === "on") {
    if (
      source.kind !== "thread" ||
      source.taskKey === target.taskKey ||
      source.threadRef.environmentId !== target.taskRef.environmentId
    )
      return null;
    return { kind: "move-to-task", threadRef: source.threadRef, taskRef: target.taskRef };
  }
  if (target.kind === "draft" || target.kind === "task-new-thread") return null;
  const section =
    target.kind === "marker"
      ? target.marker === "pinned-header"
        ? "pinned"
        : target.marker === "pinned-divider" || target.marker === "active-placeholder"
          ? "active"
          : target.marker === "snoozed-header"
            ? "snoozed"
            : "settled"
      : target.kind === "task-settled-header"
        ? "settled"
        : target.section;
  if (section === "snoozed") return null;
  const targetParent =
    target.kind === "thread" || target.kind === "task-settled-header" ? target.taskKey : undefined;
  const sourceParent = source.kind === "thread" ? source.taskKey : undefined;
  if (sourceParent !== targetParent) {
    if (source.kind === "thread" && sourceParent && !targetParent && section === "active")
      return { kind: "remove-from-task", threadRef: source.threadRef, section: "active" };
    return null;
  }
  if (sourceParent && section === "pinned") return null;
  const peers = items.filter(
    (item): item is MovableTaskSidebarItem =>
      (item.kind === "task" || item.kind === "thread") &&
      (item.kind === "thread" ? item.taskKey : undefined) === sourceParent &&
      item.section === section &&
      item.key !== sourceKey,
  );
  let index = peers.findIndex((item) => item.key === targetKey);
  if (index < 0)
    index =
      target.kind === "marker" &&
      (target.marker === "pinned-header" || target.marker === "pinned-divider")
        ? 0
        : peers.length;
  else if (
    placement === "after" ||
    (placement === "on" && items.indexOf(source) < items.indexOf(target))
  )
    index += 1;
  const order = peers.map((item) => item.key);
  order.splice(index, 0, source.key);
  return {
    kind: "reorder",
    source,
    section,
    order,
    ...(sourceParent ? { taskKey: sourceParent } : {}),
  };
}

/** Pass the canonical inventory, including hidden rows, to reserve their manual keys. */
export function planTaskSidebarReorder(
  drop: Extract<TaskSidebarDrop, { kind: "reorder" }>,
  rows: readonly TaskOrderRow[],
) {
  if (drop.section === "settled") return [];
  const taskIds = new Set(rows.filter((row) => row.kind === "task").map((row) => row.id));
  const orderId = (key: string) => (taskIds.has(key) ? key : `thread:${key}`);
  return planTaskRowReorder({
    rows,
    orderedIds: drop.order.map(orderId),
    movedId: orderId(drop.source.key),
    shelf: drop.section,
  });
}
