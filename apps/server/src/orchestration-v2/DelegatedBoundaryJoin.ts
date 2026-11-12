import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

type Run = OrchestrationV2ThreadProjection["runs"][number];
type Message = OrchestrationV2ThreadProjection["messages"][number];

export function canJoinDelegatedBoundary(
  queued: Run,
  target: Run | undefined,
  message: Message,
  child: OrchestrationV2ThreadProjection["thread"],
  tasks: OrchestrationV2ThreadProjection["subagents"],
): boolean {
  if (queued.delegatedTaskId === undefined) return true;
  const parentThreadId = child.lineage.parentThreadId;
  const followup = tasks.find((task) => task.id === queued.delegatedTaskId);
  const running = tasks.find((task) => task.id === target?.delegatedTaskId);
  return (
    parentThreadId !== null &&
    message.senderThreadId === parentThreadId &&
    followup !== undefined &&
    running !== undefined &&
    followup.id !== running.id &&
    followup.origin === "app_owned" &&
    running.origin === "app_owned" &&
    followup.threadId === parentThreadId &&
    running.threadId === parentThreadId &&
    followup.childThreadId === child.id &&
    running.childThreadId === child.id &&
    followup.runId !== null &&
    followup.runId === running.runId &&
    followup.parentNodeId === running.parentNodeId &&
    followup.result === null &&
    running.result === null
  );
}
