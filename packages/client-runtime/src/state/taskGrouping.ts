import type {
  EnvironmentId,
  OrchestrationTaskShell,
  OrchestrationThreadShell,
  ScopedTaskRef,
  ScopedThreadRef,
} from "@t3tools/contracts";

import {
  scopedProjectKey,
  scopedTaskKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeTaskRef,
  scopeThreadRef,
} from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { canSnooze, effectiveSnoozed, hasQueuedTurnStart } from "./threadSettled.ts";
import {
  planPinnedReorder,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "./threadSort.ts";

/** Generic pending input can be a dismissable message-mode question. The server checks native requests. */
export function taskSettleBlocker(
  members: readonly Pick<
    OrchestrationThreadShell,
    | "archivedAt"
    | "session"
    | "latestTurn"
    | "latestUserMessageAt"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
  >[],
  options: { readonly now: string },
) {
  return (
    members.find(
      (thread) =>
        thread.archivedAt === null &&
        (thread.session?.status === "starting" ||
          thread.session?.status === "running" ||
          thread.latestTurn?.state === "running" ||
          thread.hasPendingApprovals ||
          hasQueuedTurnStart(thread, options)),
    ) ?? null
  );
}
export function taskSnoozeBlocker(
  members: readonly Pick<
    OrchestrationThreadShell,
    | "archivedAt"
    | "session"
    | "latestTurn"
    | "latestUserMessageAt"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
  >[],
  options: { readonly now: string },
) {
  return (
    members.find(
      (thread) =>
        thread.archivedAt === null &&
        (!canSnooze(thread, options) ||
          (thread.latestTurn?.state === "running" && thread.latestTurn.startedAt === null)),
    ) ?? null
  );
}

export type TaskGroupingTask = OrchestrationTaskShell & { readonly environmentId: EnvironmentId };

/** Build once for a shell snapshot; containers then look up members without rescanning threads. */
export function buildTaskMembershipIndex<T extends EnvironmentThreadShell>(
  threads: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const members = new Map<string, T[]>();
  for (const thread of threads) {
    if (thread.taskId == null) continue;
    const key = scopedTaskKey(scopeTaskRef(thread.environmentId, thread.taskId));
    const existing = members.get(key);
    if (existing === undefined) members.set(key, [thread]);
    else existing.push(thread);
  }
  return members;
}

/** Use the thread lifecycle rules within a task; local queued work keeps settled members live. */
export function partitionTaskMembers<T extends EnvironmentThreadShell>(
  members: readonly T[],
  options: { readonly now: string; readonly queuedThreadKeys?: ReadonlySet<string> },
): { live: T[]; snoozed: T[]; settled: T[] } {
  const live: T[] = [];
  const snoozed: T[] = [];
  const settled: T[] = [];
  for (const member of members) {
    if (member.archivedAt !== null) continue;
    if (effectiveSnoozed(member, options)) {
      snoozed.push(member);
    } else if (member.settledOverride === "settled" && !taskMemberHasLocalWork(member, options)) {
      settled.push(member);
    } else {
      live.push(member);
    }
  }
  return { live, snoozed, settled };
}

export type TaskMemberStatus =
  | "approval"
  | "input"
  | "working"
  | "error"
  | "background"
  | "monitoring"
  | "idle";

type TaskStatusInput = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness"
>;

/** Semantic state only: clients choose their own labels and icons. */
export function taskMemberStatus(member: TaskStatusInput): TaskMemberStatus {
  if (member.hasPendingApprovals) return "approval";
  if (member.hasPendingUserInput) return "input";
  if (member.session?.status === "starting" || member.session?.status === "running")
    return "working";
  if (member.session?.status === "error") return "error";
  if (member.backgroundLiveness === "working") return "background";
  if (member.backgroundLiveness === "monitoring") return "monitoring";
  return "idle";
}

const STATUS_PRIORITY: Record<TaskMemberStatus, number> = {
  approval: 0,
  input: 1,
  working: 2,
  error: 3,
  background: 4,
  monitoring: 5,
  idle: 6,
};

/** Pass partitionTaskMembers(...).live so parked members do not demand task attention. */
export function rollupTaskStatus(liveMembers: readonly TaskStatusInput[]): TaskMemberStatus {
  let status: TaskMemberStatus = "idle";
  for (const member of liveMembers) {
    const candidate = taskMemberStatus(member);
    if (STATUS_PRIORITY[candidate] < STATUS_PRIORITY[status]) status = candidate;
    if (status === "approval") break;
  }
  return status;
}

/** Classify visible tasks only. Timer wakes retain their saved order and require no server timer. */
export function taskShelf(task: OrchestrationTaskShell, now: string) {
  if (task.snoozedUntil !== null && Date.parse(task.snoozedUntil) > Date.parse(now))
    return "snoozed";
  if (task.settledOverride === "settled") return "settled";
  if (task.pinnedAt !== null) return "pinned";
  return "active";
}

/** Container search does not make unrelated children match. */
export function taskMatchesSearch(
  task: Pick<OrchestrationTaskShell, "name" | "description">,
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  return (
    !normalized ||
    task.name.toLocaleLowerCase().includes(normalized) ||
    task.description?.toLocaleLowerCase().includes(normalized) === true
  );
}

/** Both native outbox messages and a server-accepted start awaiting adoption are pending work. */
export function taskMemberHasLocalWork(
  member: EnvironmentThreadShell,
  options: {
    readonly now: string;
    readonly queuedThreadKeys?: ReadonlySet<string>;
  },
) {
  return (
    member.archivedAt === null &&
    (options.queuedThreadKeys?.has(
      scopedThreadKey(scopeThreadRef(member.environmentId, member.id)),
    ) === true ||
      hasQueuedTurnStart(member, options))
  );
}

/** Pending creations here have already passed the client's invested-draft filter. */
export function taskHasLocalWork(input: {
  readonly members: readonly EnvironmentThreadShell[];
  readonly pendingCount: number;
  readonly now: string;
  readonly queuedThreadKeys?: ReadonlySet<string>;
}) {
  return (
    input.pendingCount > 0 || input.members.some((member) => taskMemberHasLocalWork(member, input))
  );
}

/** Local work changes presentation only; selection never changes the saved expansion choice. */
export function resolveTaskPresentation(input: {
  readonly task: TaskGroupingTask;
  readonly now: string;
  readonly hasLocalWork: boolean;
  readonly collapsed: boolean;
  readonly searching: boolean;
  readonly hasMatchingChildren: boolean;
}) {
  const shelf = input.hasLocalWork
    ? input.task.pinnedAt
      ? "pinned"
      : "active"
    : taskShelf(input.task, input.now);
  return { shelf, expanded: input.searching ? input.hasMatchingChildren : !input.collapsed };
}

/** Selected and pending children survive collapse without revealing their siblings. */
export function taskChildVisible(input: {
  readonly expanded: boolean;
  readonly matches: boolean;
  readonly selected: boolean;
  readonly pending: boolean;
}) {
  return (input.expanded && input.matches) || input.selected || input.pending;
}

export function resolveSettledTaskTimestamp(task: OrchestrationTaskShell): string {
  return task.settledAt ?? task.updatedAt;
}

/** Project scopes stay flat; unavailable task parents also leave their members discoverable. */
export function groupThreadsByTask<
  TTask extends TaskGroupingTask,
  TThread extends EnvironmentThreadShell,
>(input: {
  readonly tasks: readonly TTask[];
  readonly threads: readonly TThread[];
  readonly projectScope?: ReadonlySet<string> | null;
  readonly taskCapableEnvironmentIds: ReadonlySet<EnvironmentId>;
}): {
  tasks: TTask[];
  ungrouped: TThread[];
  membersByTaskKey: ReadonlyMap<string, readonly TThread[]>;
} {
  const threads = input.threads.filter((thread) => thread.archivedAt === null);
  const membersByTaskKey = buildTaskMembershipIndex(threads);
  if (input.projectScope != null) {
    return {
      tasks: [],
      ungrouped: threads.filter((thread) =>
        input.projectScope!.has(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ),
      ),
      membersByTaskKey,
    };
  }
  const tasks = input.tasks.filter(
    (task) => task.archivedAt === null && input.taskCapableEnvironmentIds.has(task.environmentId),
  );
  const taskKeys = new Set(
    tasks.map((task) => scopedTaskKey(scopeTaskRef(task.environmentId, task.id))),
  );
  return {
    tasks,
    ungrouped: threads.filter(
      (thread) =>
        thread.taskId == null ||
        !taskKeys.has(scopedTaskKey(scopeTaskRef(thread.environmentId, thread.taskId))),
    ),
    membersByTaskKey,
  };
}

type TaskOrderFields = Pick<
  OrchestrationThreadShell,
  "createdAt" | "unsettledAt" | "pinOrderKey" | "activeOrderKey"
> & { readonly id: string; readonly environmentId: EnvironmentId };

export type TaskOrderRow = TaskOrderFields &
  (
    | { readonly kind: "task"; readonly ref: ScopedTaskRef; readonly entity: TaskGroupingTask }
    | {
        readonly kind: "thread";
        readonly ref: ScopedThreadRef;
        readonly entity: EnvironmentThreadShell;
      }
  );

export function taskOrderRow(task: TaskGroupingTask): TaskOrderRow {
  const ref = scopeTaskRef(task.environmentId, task.id);
  return {
    kind: "task",
    ref,
    entity: task,
    id: `task:${scopedTaskKey(ref)}`,
    environmentId: task.environmentId,
    createdAt: task.createdAt,
    unsettledAt: task.unsettledAt,
    pinOrderKey: task.pinOrderKey,
    activeOrderKey: task.activeOrderKey,
  };
}

export function threadOrderRow(thread: EnvironmentThreadShell): TaskOrderRow {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  return {
    kind: "thread",
    ref,
    entity: thread,
    id: `thread:${scopedThreadKey(ref)}`,
    environmentId: thread.environmentId,
    createdAt: thread.createdAt,
    unsettledAt: thread.unsettledAt,
    pinOrderKey: thread.pinOrderKey,
    activeOrderKey: thread.activeOrderKey,
  };
}

export function sortTaskRowsByOrderKey<T extends TaskOrderRow>(
  rows: readonly T[],
  shelf: "active" | "pinned",
): T[] {
  return shelf === "active" ? sortActiveThreadsByOrderKey(rows) : sortPinnedThreadsByOrderKey(rows);
}

export type TaskRowOrderAssignment = { readonly orderKey: string } & (
  | { readonly kind: "task"; readonly ref: ScopedTaskRef }
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
);

/** Include hidden rows in rows to reserve their keys. Dispatch each assignment using its real ref. */
export function planTaskRowReorder(input: {
  readonly rows: readonly TaskOrderRow[];
  readonly orderedIds: readonly string[];
  readonly movedId: string;
  readonly shelf: "active" | "pinned";
}): readonly TaskRowOrderAssignment[] {
  const rowsById = new Map(input.rows.map((row) => [row.id, row]));
  if (
    new Set(input.orderedIds).size !== input.orderedIds.length ||
    input.orderedIds.some((id) => !rowsById.has(id))
  )
    return [];
  const keyField = input.shelf === "active" ? "activeOrderKey" : "pinOrderKey";
  return planPinnedReorder({
    orderedIds: input.orderedIds,
    movedId: input.movedId,
    keysById: new Map(input.rows.map((row) => [row.id, row[keyField]])),
  }).map(({ id, orderKey }) => {
    const row = rowsById.get(id)!;
    return row.kind === "task"
      ? { kind: "task", ref: row.ref, orderKey }
      : { kind: "thread", ref: row.ref, orderKey };
  });
}
