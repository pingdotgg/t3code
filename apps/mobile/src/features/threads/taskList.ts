import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  groupThreadsByTask,
  partitionTaskMembers,
  rollupTaskStatus,
  effectiveTaskShelf,
  taskOrderRow,
  threadOrderRow,
  sortTaskRowsByOrderKey,
  taskMatchesSearch,
  taskHasLocalWork,
  taskMemberHasLocalWork,
  resolveTaskPresentation,
  taskChildVisible,
  taskThreadPreview,
  type TaskMemberStatus,
} from "@t3tools/client-runtime/state/task-grouping";
import {
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  type ThreadListV2ListItem,
} from "./threadListV2";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

export type MobileTaskListItem =
  | (({ readonly type: "task-card" } | { readonly type: "task-slim" }) & {
      readonly key: string;
      readonly task: EnvironmentTask;
      readonly expanded: boolean;
      /** A retained header has collapsed members; selection alone may keep one child visible. */
      readonly retainedShelfVisibleCount?: number;
      readonly count: number;
      readonly selected?: boolean;
      readonly snoozed?: boolean;
      readonly status: TaskMemberStatus;
      readonly members: readonly EnvironmentThreadShell[];
      readonly primaryProject: EnvironmentProject | null;
      readonly snoozeWakeLabelText: string | undefined;
    })
  | {
      readonly type: "task-subshelf-header";
      readonly key: string;
      readonly task: EnvironmentTask;
      readonly expanded: boolean;
      readonly count: number;
    }
  | {
      readonly type: "task-thread-limit";
      readonly key: string;
      readonly task: EnvironmentTask;
      readonly expanded: boolean;
      readonly count: number;
    };

export function mobileTaskKey(task: Pick<EnvironmentTask, "environmentId" | "id">) {
  return `${task.environmentId}:${task.id}`;
}

/** Classify canonical top-level units before shelf collapse and paging discard rows. */
export function buildMobileTaskListItems(
  input: {
    readonly tasks: readonly EnvironmentTask[];
    readonly projects: readonly EnvironmentProject[];
    readonly threads: readonly EnvironmentThreadShell[];
    readonly pendingTasks: readonly PendingNewTask[];
    readonly capableIds: ReadonlySet<EnvironmentId>;
    readonly collapsedTaskKeys: ReadonlySet<string>;
    readonly expandedTaskShelfKeys: ReadonlySet<string>;
    readonly showAllTaskKeys?: ReadonlySet<string>;
    readonly taskThreadPreviewCount?: number;
    readonly projectScoped: boolean;
    readonly selectedTaskKey?: string | null;
  } & Omit<Parameters<typeof buildThreadListV2Items>[0], "threads">,
) {
  const groups = groupThreadsByTask({
    tasks: input.projectScoped ? [] : input.tasks,
    threads: input.threads,
    taskCapableEnvironmentIds: input.capableIds,
  });
  const projectsByKey = new Map(
    input.projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const taskKeys = new Set(groups.tasks.map(mobileTaskKey));
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const searching = query.length > 0;
  const threadKey = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;
  const selected = (thread: EnvironmentThreadShell) =>
    threadKey(thread) === input.selectedThreadKey;
  const queued = (thread: EnvironmentThreadShell) => taskMemberHasLocalWork(thread, input);
  const matches = (thread: EnvironmentThreadShell) =>
    !query ||
    thread.title.toLocaleLowerCase().includes(query) ||
    threadPullRequestSearchTerms(thread).some((term) => term.toLocaleLowerCase().includes(query)) ||
    input.matchedThreadKeys?.has(threadKey(thread)) === true;
  const pendingByTask = new Map<string, PendingNewTask[]>();
  const flatPending: PendingNewTask[] = [];
  const projectKeys =
    input.projectRefs == null
      ? null
      : new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`));
  for (const pending of input.pendingTasks) {
    if (input.environmentId !== null && input.environmentId !== pending.environmentId) continue;
    if (projectKeys !== null && !projectKeys.has(`${pending.environmentId}:${pending.projectId}`))
      continue;
    const key = `${pending.environmentId}:${pending.taskId}`;
    if (pending.taskId != null && taskKeys.has(key)) {
      const group = pendingByTask.get(key);
      if (group) group.push(pending);
      else pendingByTask.set(key, [pending]);
    } else if (!query || pending.title.toLocaleLowerCase().includes(query))
      flatPending.push(pending);
  }
  const flat = buildThreadListV2Items({
    ...input,
    threads: groups.ungrouped,
    settledLimit: Infinity,
    snoozedShelfExpanded: true,
    settledShelfExpanded: true,
  });
  let nextSnoozeWakeAt = flat.nextSnoozeWakeAt;
  const includeWake = (value: string | null | undefined) => {
    if (
      value != null &&
      Date.parse(value) > Date.parse(input.now) &&
      (nextSnoozeWakeAt === null || value < nextSnoozeWakeAt)
    )
      nextSnoozeWakeAt = value;
  };
  const blocks = new Map<string, ThreadListV2ListItem[]>();
  const retainedBlocks = new Map<string, ThreadListV2ListItem[]>();
  const orderedRows = {
    pinned: [] as ReturnType<typeof taskOrderRow>[],
    active: [] as ReturnType<typeof taskOrderRow>[],
    snoozed: [] as ReturnType<typeof taskOrderRow>[],
    settled: [] as ReturnType<typeof taskOrderRow>[],
  };
  for (const task of groups.tasks) {
    if (input.environmentId !== null && input.environmentId !== task.environmentId) continue;
    const key = mobileTaskKey(task);
    const members = groups.membersByTaskKey.get(key) ?? [];
    includeWake(task.snoozedUntil);
    for (const member of members) includeWake(member.snoozedUntil);
    const pending = pendingByTask.get(key) ?? [];
    const selectedMember = members.some(selected);
    const hasLocalWork = taskHasLocalWork({ ...input, members, pendingCount: pending.length });
    if (
      !taskMatchesSearch(task, query) &&
      !members.some(matches) &&
      !pending.some((item) => item.title.toLocaleLowerCase().includes(query)) &&
      !selectedMember &&
      key !== input.selectedTaskKey &&
      !hasLocalWork
    )
      continue;
    const effectiveShelf = effectiveTaskShelf({ task, now: input.now, hasLocalWork });
    const { shelf, expanded } = resolveTaskPresentation({
      task,
      now: input.now,
      hasLocalWork,
      searching,
      hasMatchingChildren:
        members.some(matches) ||
        pending.some((item) => !query || item.title.toLocaleLowerCase().includes(query)),
      collapsed:
        effectiveShelf === "active" || effectiveShelf === "pinned"
          ? input.collapsedTaskKeys.has(key)
          : !input.collapsedTaskKeys.has(`parked:${key}`),
    });
    const parked = shelf === "snoozed" || shelf === "settled";
    const partition = partitionTaskMembers(members, input);
    const live = sortActiveThreadsByOrderKey(partition.live);
    const snoozed = [...partition.snoozed].sort(
      (a, b) =>
        (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? "") ||
        threadKey(a).localeCompare(threadKey(b)),
    );
    const settled = [...partition.settled].sort(
      (a, b) =>
        (resolveSettledThreadTimestamp(b) ?? "").localeCompare(
          resolveSettledThreadTimestamp(a) ?? "",
        ) || threadKey(a).localeCompare(threadKey(b)),
    );
    const showAll = input.showAllTaskKeys?.has(key) === true;
    const preview = taskThreadPreview([...live, ...snoozed, ...settled], {
      limit: input.taskThreadPreviewCount,
      showAll,
      searching,
    });
    const block: ThreadListV2ListItem[] = [
      {
        type: parked ? "task-slim" : "task-card",
        key: `task:${key}`,
        task,
        expanded,
        count: members.length + pending.length,
        selected: key === input.selectedTaskKey,
        snoozed: shelf === "snoozed",
        status: rollupTaskStatus(partition.live),
        members,
        primaryProject: projectsByKey.get(`${task.environmentId}:${task.primaryProjectId}`) ?? null,
        snoozeWakeLabelText:
          shelf === "snoozed" && task.snoozedUntil !== null
            ? snoozeWakeLabel(task.snoozedUntil, { now: input.now })
            : undefined,
      },
    ];
    const addMember = (
      thread: EnvironmentThreadShell,
      slim: boolean,
      snoozed: boolean,
      showExpanded = expanded,
    ) => {
      if (
        !taskChildVisible({
          expanded: showExpanded && preview.members.has(thread),
          matches: matches(thread),
          selected: selected(thread),
          pending: queued(thread),
        })
      )
        return;
      block.push({
        type: "v2-thread",
        key: `v2-thread:${threadKey(thread)}`,
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
    for (const thread of live) addMember(thread, parked, false);
    for (const thread of snoozed) addMember(thread, true, true);
    for (const pendingTask of pending)
      block.push({
        type: "v2-pending",
        key: `v2-${pendingTask.key}`,
        pendingTask,
        showPendingDivider: false,
      });
    const shelfExpanded = searching || input.expandedTaskShelfKeys.has(key);
    if (
      !parked &&
      ((expanded && settled.some((thread) => preview.members.has(thread))) ||
        settled.some((thread) => selected(thread) || queued(thread)))
    ) {
      block.push({
        type: "task-subshelf-header",
        key: `task-settled:${key}`,
        task,
        count: partition.settled.length,
        expanded: shelfExpanded,
      });
    }
    for (const thread of settled) {
      addMember(thread, true, false, expanded && (parked || shelfExpanded));
    }
    if (expanded && !searching && preview.overflowing) {
      block.push({
        type: "task-thread-limit",
        key: `task-limit:${key}`,
        task,
        expanded: showAll,
        count: members.length,
      });
    }
    const row = taskOrderRow(task);
    orderedRows[shelf].push(row);
    blocks.set(row.id, block);
    if (selectedMember || key === input.selectedTaskKey)
      retainedBlocks.set(
        row.id,
        block.filter(
          (item) =>
            item.type === "task-card" ||
            item.type === "task-slim" ||
            (item.type === "v2-thread" && selected(item.item.thread)),
        ),
      );
  }
  for (const item of buildThreadListV2ListItems({
    items: flat.items,
    pendingTasks: [],
    snoozeLabelNow: input.now,
  })) {
    if (item.type !== "v2-thread") continue;
    const row = threadOrderRow(item.item.thread);
    const shelf = item.item.snoozed
      ? "snoozed"
      : item.item.variant === "slim"
        ? "settled"
        : item.item.pinned
          ? "pinned"
          : "active";
    orderedRows[shelf].push(row);
    blocks.set(row.id, [item]);
    if (selected(item.item.thread)) retainedBlocks.set(row.id, [item]);
  }
  for (const shelf of ["pinned", "active"] as const) {
    // Preserve optimistic thread ordering in flat scopes; task arrangement uses canonical mixed order.
    if (!groups.tasks.length) continue;
    orderedRows[shelf] = sortTaskRowsByOrderKey(orderedRows[shelf], shelf);
  }
  orderedRows.snoozed.sort(
    (a, b) =>
      (a.entity.snoozedUntil ?? "").localeCompare(b.entity.snoozedUntil ?? "") ||
      a.id.localeCompare(b.id),
  );
  const settledTime = (row: ReturnType<typeof taskOrderRow>) =>
    row.kind === "task"
      ? (row.entity.settledAt ?? row.entity.updatedAt)
      : (resolveSettledThreadTimestamp(row.entity) ?? "");
  orderedRows.settled.sort(
    (a, b) => settledTime(b).localeCompare(settledTime(a)) || a.id.localeCompare(b.id),
  );
  const items: ThreadListV2ListItem[] = [];
  const appendBlock = (id: string, showFull: boolean, visibleCount: number) => {
    const block = (showFull ? blocks : retainedBlocks).get(id) ?? [];
    items.push(
      ...block.map((item) =>
        !showFull && (item.type === "task-card" || item.type === "task-slim")
          ? { ...item, expanded: false, retainedShelfVisibleCount: visibleCount }
          : item,
      ),
    );
  };
  for (const shelf of ["pinned", "active"] as const)
    for (const row of orderedRows[shelf]) items.push(...blocks.get(row.id)!);
  items.push(
    ...flatPending.map((pendingTask, index): ThreadListV2ListItem => ({
      type: "v2-pending",
      key: `v2-${pendingTask.key}`,
      pendingTask,
      showPendingDivider: index === 0,
    })),
  );
  if (orderedRows.snoozed.length) {
    items.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: orderedRows.snoozed.length,
      expanded: searching || input.snoozedShelfExpanded === true,
    });
    for (const row of orderedRows.snoozed) {
      const showFull = searching || input.snoozedShelfExpanded === true;
      appendBlock(row.id, showFull, 0);
    }
  }
  const settledLimit = searching ? Infinity : (input.settledLimit ?? Infinity);
  let pagedSettledCount = 0;
  if (orderedRows.settled.length) {
    items.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: orderedRows.settled.length,
      expanded: searching || input.settledShelfExpanded !== false,
    });
    for (const [index, row] of orderedRows.settled.entries()) {
      const withinPage = index < settledLimit;
      if (withinPage || retainedBlocks.has(row.id)) pagedSettledCount += 1;
      const showFull = searching || (input.settledShelfExpanded !== false && withinPage);
      appendBlock(row.id, showFull, index + 1);
    }
  }
  return {
    items,
    counts: {
      pinned: orderedRows.pinned.length,
      active: orderedRows.active.length,
      snoozed: orderedRows.snoozed.length,
      settled: orderedRows.settled.length,
    },
    hiddenSettledCount: orderedRows.settled.length - pagedSettledCount,
    nextSnoozeWakeAt,
  };
}
