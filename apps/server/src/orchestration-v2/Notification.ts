import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Notification,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

/** Keep the delivery message intact while projecting its trigger as an activity. */
export function notificationTurnItem(
  item: OrchestrationV2TurnItem,
  message: OrchestrationV2ConversationMessage,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
): OrchestrationV2TurnItem {
  if (item.type !== "user_message") return item;
  let notification = message.notification;
  if (message.delegatedCompletion !== undefined) {
    const taskIds = message.delegatedCompletion.taskIds;
    const selected = tasks.filter((task) => taskIds.includes(task.id));
    const outcome: OrchestrationV2Notification["outcome"] = selected.some(
      (task) => task.status === "failed",
    )
      ? "failed"
      : selected.some((task) => task.status === "cancelled" || task.status === "interrupted")
        ? "cancelled"
        : selected.length === taskIds.length &&
            selected.every((task) => task.status === "completed")
          ? "completed"
          : "unknown";
    const label =
      taskIds.length === 1
        ? selected[0]?.title?.trim() || "Delegated task"
        : `${taskIds.length} delegated tasks`;
    notification = {
      source: { kind: "delegated_task", taskIds },
      outcome,
      summary: `${label} ${outcome === "failed" ? "failed" : outcome === "cancelled" ? "stopped" : "finished"}`,
    };
  }
  if (notification === undefined) return item;
  const {
    type: _type,
    messageId: _messageId,
    inputIntent: _inputIntent,
    text: _text,
    attachments: _attachments,
    createdBy: _createdBy,
    creationSource: _creationSource,
    scheduledTaskId: _scheduledTaskId,
    ...base
  } = item;
  return { ...base, type: "notification", ...notification };
}
