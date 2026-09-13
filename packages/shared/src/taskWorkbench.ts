import type { TaskId } from "@t3tools/contracts";

export function taskWorkbenchId(taskId: TaskId): string {
  return `task:${taskId}`;
}
