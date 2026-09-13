import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  groupThreadsByTask,
  taskOrderRow,
  threadOrderRow,
  taskShelf,
  sortTaskRowsByOrderKey,
  planTaskRowReorder,
  type TaskOrderRow,
} from "@t3tools/client-runtime/state/task-grouping";
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

/** Top-level entities share order keys; members can move only among siblings in their environment. */
export function planMobileTaskMove(input: {
  tasks: readonly EnvironmentTask[];
  threads: readonly EnvironmentThreadShell[];
  capableIds: ReadonlySet<EnvironmentId>;
  writableTaskIds: ReadonlySet<EnvironmentId>;
  writableThreadIds: ReadonlySet<EnvironmentId>;
  moved: TaskOrderRow;
  destination: ThreadMoveDestination;
  now: string;
  queued: ReadonlySet<string>;
}) {
  const currentShelf = mobileOrderShelf(input.moved, input.now, input.queued);
  const shelf =
    typeof input.destination === "object"
      ? (input.destination.section ?? currentShelf)
      : currentShelf;
  if (shelf !== "active" && shelf !== "pinned") return null;
  const memberThread = input.moved.kind === "thread" ? input.moved.entity : null;
  const member = memberThread?.taskId != null;
  if (member && shelf === "pinned") return null;
  const rows =
    member && input.moved.kind === "thread"
      ? input.threads
          .filter(
            (thread) =>
              thread.environmentId === input.moved.environmentId &&
              thread.taskId === memberThread?.taskId &&
              thread.archivedAt === null,
          )
          .map(threadOrderRow)
      : mobileOrderRows(input);
  if (!rows.some((row) => row.id === input.moved.id)) return null;
  const ordered = sortTaskRowsByOrderKey(
    rows.filter((row) => mobileOrderShelf(row, input.now, input.queued) === shelf),
    shelf,
  );
  const destination =
    typeof input.destination === "object" &&
    input.destination.targetId != null &&
    !input.destination.targetId.startsWith("task:") &&
    !input.destination.targetId.startsWith("thread:")
      ? { ...input.destination, targetId: `thread:${input.destination.targetId}` }
      : input.destination;
  const ids = threadOrderAfterMove(
    ordered.map((row) => row.id),
    input.moved.id,
    destination,
  );
  if (ids === null) return null;
  const assignments = planTaskRowReorder({
    rows: [...input.tasks.map(taskOrderRow), ...input.threads.map(threadOrderRow)],
    orderedIds: ids,
    movedId: input.moved.id,
    shelf,
  });
  if (
    !assignments.length ||
    assignments.some(
      (item) =>
        !(item.kind === "task" ? input.writableTaskIds : input.writableThreadIds).has(
          item.ref.environmentId,
        ),
    )
  )
    return null;
  return { shelf, assignments, crossSection: currentShelf !== shelf };
}
