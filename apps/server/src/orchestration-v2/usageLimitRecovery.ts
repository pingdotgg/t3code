import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type * as ProjectionStore from "./ProjectionStore.ts";

const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

/** Whether the recovery sweep will resume this thread's usage-limited run without anyone acting. */
export function limitResumeExpected(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
): boolean {
  // Without snooze, the sweep only arms a recovery that auto-resumes, or sends the resume itself.
  if (limitRecoveryCommand(thread, autoResume, nowMs) !== null) return true;
  // Armed and waiting for its reset or its snooze to end; the sweep returns null until then.
  const recovery = thread.limitRecovery;
  return (
    thread.status === "failed" &&
    thread.lastErrorClass === "usage_limit" &&
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    thread.pendingRuntimeRequest === null &&
    recovery?.autoResume === true &&
    recovery.runId === thread.latestRunId &&
    recovery.resetAt === thread.usageLimitResetAt
  );
}
