import type { TaskId } from "@t3tools/contracts";

export function taskWorkbenchId(taskId: TaskId): string {
  return `task:${taskId}`;
}

/** Task resource owners reserve this prefix; real conversation IDs cannot use it. */
export function isTaskWorkbenchId(value: string): boolean {
  return value.startsWith("task:");
}
