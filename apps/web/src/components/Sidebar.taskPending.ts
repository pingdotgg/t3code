import type { EnvironmentId, TaskId } from "@t3tools/contracts";
import type { EnvironmentTask, EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  scopedTaskKey,
  scopedThreadKey,
  scopeTaskRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";

export type SidebarTaskPatch = Partial<
  Pick<
    EnvironmentTask,
    | "pinnedAt"
    | "settledOverride"
    | "settledAt"
    | "snoozedUntil"
    | "snoozedAt"
    | "unsettledAt"
    | "activeOrderKey"
    | "pinOrderKey"
  >
>;
export interface PendingTaskSidebarDrop {
  readonly taskPatches: ReadonlyMap<string, SidebarTaskPatch>;
  readonly threadPatches: ReadonlyMap<string, SidebarTaskPatch & { taskId?: TaskId | null }>;
  readonly receipts: ReadonlyMap<EnvironmentId, number>;
  readonly complete: boolean;
}

/** Receipts acknowledge writes before shell delivery. Hold placement until every owning
 * environment has observed the final receipt, then let canonical state settle concurrent edits. */
export function taskSidebarDropObserved(
  pending: PendingTaskSidebarDrop,
  sequences: ReadonlyMap<EnvironmentId, number>,
): boolean {
  return (
    pending.complete &&
    [...pending.receipts].every(([id, sequence]) => (sequences.get(id) ?? -1) >= sequence)
  );
}

export function applyPendingTaskSidebarDrop(
  tasks: readonly EnvironmentTask[],
  threads: readonly EnvironmentThreadShell[],
  pending: PendingTaskSidebarDrop | null,
) {
  if (!pending) return { tasks, threads };
  return {
    tasks: tasks.map((task) => {
      const patch = pending.taskPatches.get(
        scopedTaskKey(scopeTaskRef(task.environmentId, task.id)),
      );
      return patch ? { ...task, ...patch } : task;
    }),
    threads: threads.map((thread) => {
      const patch = pending.threadPatches.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return patch ? { ...thread, ...patch } : thread;
    }),
  };
}
