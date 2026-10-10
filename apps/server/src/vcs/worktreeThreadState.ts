import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";

const IDLE_THREAD_STATUSES = new Set<OrchestrationV2ThreadShell["status"]>([
  "idle",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/**
 * A thread that is running, starting, waiting on a request or background work,
 * or has a turn queued. Its checkout is in use whatever its settled state, so
 * this blocks manual removal and Storage cleanup alike.
 */
export function worktreeThreadBusy(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.activeRunId !== null ||
    !IDLE_THREAD_STATUSES.has(thread.status) ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
    thread.pendingRuntimeRequest !== null ||
    threadHasQueuedTurnStart(thread, now)
  );
}

/** Live sessions keep their cwd even when no turn is currently running. */
export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return thread.branch !== null && thread.worktreePath !== null && !worktreeThreadBusy(thread, now);
}

/** PR metadata refreshes must not reset the inactivity clock. */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}
