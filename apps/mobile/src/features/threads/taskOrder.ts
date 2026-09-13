import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  groupThreadsByTask,
  taskOrderRow,
  threadOrderRow,
  taskShelf,
  sortTaskRowsByOrderKey,
  type TaskRowOrderAssignment,
  type TaskOrderRow,
} from "@t3tools/client-runtime/state/task-grouping";
import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { threadOrderAfterMove, type ThreadMoveDestination } from "./threadOrder";

export function mobileOrderRows(input: {
  tasks: readonly EnvironmentTask[];
  threads: readonly EnvironmentThreadShell[];
  capableIds: ReadonlySet<EnvironmentId>;
}) {
  const grouped = groupThreadsByTask({ ...input, taskCapableEnvironmentIds: input.capableIds });
  return [...grouped.tasks.map(taskOrderRow), ...grouped.ungrouped.map(threadOrderRow)];
}
export function mobileOrderShelf(row: TaskOrderRow, now: string, queued: ReadonlySet<string>) {
  if (row.kind === "task") return taskShelf(row.entity, now);
  if (effectiveSnoozed(row.entity, { now })) return "snoozed";
  if (
    row.entity.settledOverride === "settled" &&
    !queued.has(`${row.entity.environmentId}:${row.entity.id}`)
  )
    return "settled";
  return row.entity.pinnedAt != null ? "pinned" : "active";
}

export interface MobileTaskMoveSnapshot {
  tasks: readonly EnvironmentTask[];
  threads: readonly EnvironmentThreadShell[];
  capableIds: ReadonlySet<EnvironmentId>;
  writableTaskIds: ReadonlySet<EnvironmentId>;
  writableThreadIds: ReadonlySet<EnvironmentId>;
  writablePinnedThreadIds?: ReadonlySet<EnvironmentId>;
  now: string;
  queued: ReadonlySet<string>;
}

/** Prepare global shelves and sibling inventories once; queries use only this snapshot. */
export function createMobileTaskMovePlanner(input: MobileTaskMoveSnapshot) {
  const grouped = groupThreadsByTask({ ...input, taskCapableEnvironmentIds: input.capableIds });
  const top = [...grouped.tasks.map(taskOrderRow), ...grouped.ungrouped.map(threadOrderRow)];
  const all = [...input.tasks.map(taskOrderRow), ...input.threads.map(threadOrderRow)];
  const byId = new Map(all.map((row) => [row.id, row]));
  const keys = {
    active: new Map(all.map((row) => [row.id, row.activeOrderKey])),
    pinned: new Map(all.map((row) => [row.id, row.pinOrderKey])),
  };
  const prepare = (rows: readonly TaskOrderRow[]) => ({
    active: sortTaskRowsByOrderKey(
      rows.filter((row) => mobileOrderShelf(row, input.now, input.queued) === "active"),
      "active",
    ),
    pinned: sortTaskRowsByOrderKey(
      rows.filter((row) => mobileOrderShelf(row, input.now, input.queued) === "pinned"),
      "pinned",
    ),
    snoozed: rows.filter((row) => mobileOrderShelf(row, input.now, input.queued) === "snoozed"),
    settled: rows.filter((row) => mobileOrderShelf(row, input.now, input.queued) === "settled"),
  });
  const shelves = prepare(top);
  const memberRows = new Map(
    [...grouped.membersByTaskKey].map(([key, members]) => [
      key,
      sortTaskRowsByOrderKey(members.map(threadOrderRow), "active"),
    ]),
  );
  const memberShelves = new Map([...memberRows].map(([key, members]) => [key, prepare(members)]));
  const orderedIds = (inventory: ReturnType<typeof prepare>) => ({
    active: inventory.active.map((row) => row.id),
    pinned: inventory.pinned.map((row) => row.id),
  });
  const topOrder = orderedIds(shelves);
  const memberOrder = new Map(
    [...memberShelves].map(([key, inventory]) => [key, orderedIds(inventory)]),
  );
  const topIds = new Set(top.map((row) => row.id));
  const plan = (requested: TaskOrderRow, destination: ThreadMoveDestination) => {
    const moved = byId.get(requested.id);
    if (!moved || moved.entity.archivedAt !== null) return null;
    const currentShelf = mobileOrderShelf(moved, input.now, input.queued);
    const shelf =
      typeof destination === "object" ? (destination.section ?? currentShelf) : currentShelf;
    if (shelf !== "active" && shelf !== "pinned") return null;
    const memberKey =
      moved.kind === "thread" && moved.entity.taskId != null
        ? `${moved.environmentId}:${moved.entity.taskId}`
        : null;
    if (memberKey !== null && (shelf === "pinned" || shelf !== currentShelf)) return null;
    const inventory = memberKey === null ? topOrder : memberOrder.get(memberKey);
    if (!inventory || (memberKey === null && !topIds.has(moved.id))) return null;
    const normalized =
      typeof destination === "object" &&
      destination.targetId != null &&
      !destination.targetId.startsWith("task:") &&
      !destination.targetId.startsWith("thread:")
        ? { ...destination, targetId: `thread:${destination.targetId}` }
        : destination;
    const ids = threadOrderAfterMove(inventory[shelf], moved.id, normalized);
    if (ids === null) return null;
    const writable = (row: TaskOrderRow) =>
      (row.kind === "task"
        ? input.writableTaskIds
        : shelf === "pinned"
          ? (input.writablePinnedThreadIds ?? input.writableThreadIds)
          : input.writableThreadIds
      ).has(row.environmentId);
    if (!writable(moved)) return null;
    const assigned = planPinnedReorder({
      orderedIds: ids,
      keysById: keys[shelf],
      movedId: moved.id,
    });
    if (!assigned.length || assigned.some(({ id }) => !writable(byId.get(id)!))) return null;
    const assignments: TaskRowOrderAssignment[] = assigned.map(({ id, orderKey }) => {
      const row = byId.get(id)!;
      return row.kind === "task"
        ? { kind: "task", ref: row.ref, orderKey }
        : { kind: "thread", ref: row.ref, orderKey };
    });
    return { shelf, assignments, crossSection: currentShelf !== shelf };
  };
  const availability = new Map<string, boolean>();
  return {
    shelves,
    memberRows,
    byId,
    plan,
    canMove(row: TaskOrderRow, direction: "up" | "down") {
      const key = `${row.id}:${direction}`;
      if (!availability.has(key)) {
        const result = plan(row, direction);
        availability.set(key, result !== null && !result.crossSection);
      }
      return availability.get(key)!;
    },
  };
}

/** Execution prepares a fresh snapshot, so stale row objects never grant a move. */
export function planMobileTaskMove(
  input: MobileTaskMoveSnapshot & {
    moved: TaskOrderRow;
    destination: ThreadMoveDestination;
  },
) {
  return createMobileTaskMovePlanner(input).plan(input.moved, input.destination);
}

export function shouldUseMixedTaskArrangement(
  enabled: boolean,
  tasks: readonly EnvironmentTask[],
  capableIds: ReadonlySet<EnvironmentId>,
) {
  return (
    enabled && tasks.some((task) => task.archivedAt === null && capableIds.has(task.environmentId))
  );
}

/** One deadline covers tasks and members, including currently collapsed rows. */
export function nextMobileTaskSnoozeExpiry(
  tasks: readonly EnvironmentTask[],
  threads: readonly EnvironmentThreadShell[],
  now: string,
) {
  let next = Infinity;
  for (const entity of [...tasks, ...threads]) {
    const at = Date.parse(entity.snoozedUntil ?? "");
    if (entity.archivedAt === null && at > Date.parse(now)) next = Math.min(next, at);
  }
  return Number.isFinite(next) ? next : null;
}
