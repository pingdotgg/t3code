import {
  latestProviderTurnForAttempt,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export function isBufferedProviderNotification(
  message: OrchestrationV2ConversationMessage,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "provider" &&
    message.notification !== undefined &&
    message.delegatedCompletion === undefined
  );
}

/** Acceptance and receipts cannot commit atomically; reuse message ids for at-least-once delivery. */
export function isUndeliveredMailboxSteer(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  messageId: MessageId,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  if (message?.delegatedCompletion === undefined) return false;
  const run = projection.runs.find((candidate) => candidate.id === message.runId);
  return (
    run !== undefined &&
    run.userMessageId !== message.id &&
    (["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status) ||
      latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status ===
        "completed")
  );
}

type DelegatedCompletionRecords = Pick<
  OrchestrationV2ThreadProjection,
  "messages" | "runs" | "providerTurns"
>;

/** The run's claimed delegated completion still owes a wake: none dispatched, or its steer went unread. */
export function pendingDelegatedCompletionWake(
  projection: DelegatedCompletionRecords,
  run: Pick<OrchestrationV2Run, "delegatedCompletion">,
) {
  const delivery = run.delegatedCompletion?.delivery;
  if (run.delegatedCompletion?.disposition !== "open" || delivery == null) return undefined;
  const dispatched = projection.messages.some((message) => message.id === delivery.messageId);
  return dispatched && !isUndeliveredMailboxSteer(projection, delivery.messageId)
    ? undefined
    : delivery;
}

const TERMINAL_TASK_STATUSES: ReadonlyArray<OrchestrationV2Subagent["status"]> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/**
 * Finished delegated task items whose completion wake has not started its run: claimed into a
 * pending wake, or left pending behind a running wake, whose end reserves them a successor. A run
 * without its provider thread is never offered a wake, so its tasks hold nothing.
 */
export function delegatedTaskItemsAwaitingWake<Item extends OrchestrationV2TurnItem>(
  projection: DelegatedCompletionRecords & {
    readonly providerThreads: ReadonlyArray<{ readonly id: string }>;
    readonly subagents: ReadonlyArray<
      Pick<
        OrchestrationV2Subagent,
        "id" | "runId" | "origin" | "status" | "completionWake" | "completionDelivery"
      >
    >;
    readonly turnItems: ReadonlyArray<Item>;
  },
): ReadonlyArray<Item> {
  const taskIds = new Set<string>();
  for (const run of projection.runs) {
    if (
      run.providerThreadId === null ||
      !projection.providerThreads.some((thread) => thread.id === run.providerThreadId)
    ) {
      continue;
    }
    for (const taskId of pendingDelegatedCompletionWake(projection, run)?.taskIds ?? []) {
      taskIds.add(taskId);
    }
    if (run.delegatedCompletion?.disposition !== "open" || run.delegatedCompletion.delivery == null)
      continue;
    // Mirrors the successor reservation: a live run's blocking wait takes settled_only results.
    const runIsLive = ["preparing", "starting", "running"].includes(run.status);
    for (const task of projection.subagents) {
      if (
        task.runId === run.id &&
        task.origin === "app_owned" &&
        task.completionDelivery?.state === "pending" &&
        TERMINAL_TASK_STATUSES.includes(task.status) &&
        (!runIsLive || task.completionWake === "always")
      ) {
        taskIds.add(task.id);
      }
    }
  }
  if (taskIds.size === 0) return [];
  return projection.turnItems.filter(
    (item) =>
      item.type === "subagent" && item.origin === "app_owned" && taskIds.has(item.subagentId),
  );
}
