import type { OrchestrationEvent, ThreadTaskSettlementRestore, TaskId } from "@t3tools/contracts";

/** Lifecycle changes end an undo opportunity; settlement's own cleanup does not. */
export function taskSettlementInvalidation(event: OrchestrationEvent) {
  switch (event.type) {
    case "task.unsettled":
    case "task.archived":
    case "task.deleted":
      return { kind: "task" as const, taskId: event.payload.taskId };
    case "thread.task-set":
    case "thread.archived":
    case "thread.deleted":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
      return { kind: "thread" as const, threadId: event.payload.threadId };
    default:
      return null;
  }
}

export function invalidatesThreadTaskSettlement(
  event: OrchestrationEvent,
  restore: ThreadTaskSettlementRestore,
  currentTaskId: TaskId | null | undefined,
) {
  if (event.type === "thread.task-set") return event.payload.taskId !== currentTaskId;
  if (event.type === "thread.unsnoozed" || event.type === "thread.unpinned")
    return event.commandId !== restore.settlementId;
  return true;
}
