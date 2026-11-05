import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MESSAGE_ID_PREFIX = "scheduled-task-message:";

export function scheduledTaskFireKey(
  taskId: string,
  fire:
    | { readonly startedAtMs: number; readonly trigger: "scheduled" | "manual" | "webhook" }
    | { readonly deliveryId: string },
): string {
  return "deliveryId" in fire
    ? `${taskId}:webhook:${fire.deliveryId}`
    : `${taskId}:${fire.startedAtMs}:${fire.trigger}`;
}

export const scheduledTaskMessageId = (fireKey: string) =>
  MessageId.make(`${MESSAGE_ID_PREFIX}${fireKey}`);

export const isScheduledTaskMessageId = (messageId: MessageId) =>
  messageId.startsWith(MESSAGE_ID_PREFIX);

/** Ids the latest dispatch could have used. Task ids contain colons, so never parse one. */
export function expectedScheduledTaskMessageIds(input: {
  readonly taskId: string;
  readonly lastRunAt: string | null;
  readonly webhookDeliveryId: string | null;
}): ReadonlyArray<MessageId> {
  const { taskId, lastRunAt, webhookDeliveryId } = input;
  if (webhookDeliveryId !== null) {
    return [
      scheduledTaskMessageId(scheduledTaskFireKey(taskId, { deliveryId: webhookDeliveryId })),
    ];
  }
  const startedAt = lastRunAt === null ? Option.none() : DateTime.make(lastRunAt);
  if (Option.isNone(startedAt)) return [];
  const startedAtMs = DateTime.toEpochMillis(startedAt.value);
  return (["scheduled", "manual"] as const).map((trigger) =>
    scheduledTaskMessageId(scheduledTaskFireKey(taskId, { startedAtMs, trigger })),
  );
}

/** Null when the run did not end badly. Mobile reads only `lastRunError`, so text is required. */
export function scheduledRunFailureReason(
  run: OrchestrationV2Run,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): string | null {
  switch (run.status) {
    case "failed":
      return latestRootProviderFailure(run, turnItems)?.message ?? "The run failed.";
    case "interrupted":
      return (
        turnItems.findLast(
          (item): item is Extract<OrchestrationV2TurnItem, { type: "run_interrupt_result" }> =>
            item.runId === run.id && item.type === "run_interrupt_result",
        )?.message ?? "The run was interrupted."
      );
    case "cancelled":
      return "The run was cancelled.";
    default:
      return null;
  }
}
