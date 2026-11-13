import type { OrchestrationV2Subagent } from "@t3tools/contracts";

const DELEGATED_RESULT_INLINE_BYTES = 16_000;

type WakeTask = Pick<OrchestrationV2Subagent, "title" | "status" | "result"> & {
  readonly id: string;
};

export function delegatedCompletionWakeDetail(
  taskIds: ReadonlyArray<string>,
  tasks: ReadonlyArray<WakeTask>,
): string {
  let remainingBytes = DELEGATED_RESULT_INLINE_BYTES;
  return taskIds
    .map((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      const label = `Delegated task ${taskId}${task?.title == null ? "" : ` (${task.title})`}${task === undefined ? " reached a terminal state" : ` [${task.status}]`}`;
      if (task?.result != null) {
        const detail = `${label}:\n${task.result}`;
        const bytes = Buffer.byteLength(detail);
        if (bytes <= remainingBytes) {
          remainingBytes -= bytes;
          return detail;
        }
      }
      return `${label}. Use task_status with taskId ${taskId} to read the result.`;
    })
    .join("\n\n");
}
