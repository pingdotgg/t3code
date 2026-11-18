import {
  type CommandId,
  latestProviderTurnForAttempt,
  type MessageId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Notification,
  type OrchestrationV2ThreadProjection,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ServerSettingsService } from "../serverSettings.ts";
import { capNotificationDetail } from "./ContextHandoffDelivery.ts";

/** The id of the row `thread.notice.record` writes for a command, so a caller can tell it was recorded. */
export const threadNoticeTurnItemId = (commandId: CommandId): TurnItemId =>
  TurnItemId.make(`turn-item:notice:${commandId}`);

/** Reads a wake switch; settings that cannot be read keep the wake on. */
export const wakeSwitch = (
  settings: ServerSettingsService["Service"],
  key:
    | "t3WakeOnDelegateFinished"
    | "t3WakeOnDelegateQuestion"
    | "t3WakeOnPullRequestUpdate"
    | "t3GoalContinuation",
): Effect.Effect<boolean> =>
  settings.getSettings.pipe(
    Effect.map((current: ServerSettings) => current[key]),
    Effect.orElseSucceed(() => true),
  );

/** The row recorded in place of a wake that is switched off; `detail` is what the wake would have said. */
export const suppressedWakeNotice = (
  what: string,
  detail: string,
): OrchestrationV2Notification => ({
  source: { kind: "system" },
  outcome: "cancelled",
  summary: `${what}. T3 Code did not wake the agent (switched off in Settings)`,
  detail: capNotificationDetail(detail),
});

export function isBufferedProviderNotification(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "notification" | "delegatedCompletion"
  >,
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
