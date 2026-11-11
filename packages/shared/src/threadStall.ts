import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  backgroundWorkHoldsCompletion,
  monitorHoldsWakeCompletion,
} from "./orchestrationV2PendingBackgroundWork.ts";

/** Quiet open work past this age is stalled. Long enough to skip normal tool gaps. */
export const DEFAULT_THREAD_STALL_AFTER_MS = 30 * 60 * 1_000;

const LIVE_AGENT_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export type ThreadStallShell = Pick<
  OrchestrationV2ThreadShell,
  | "activityRunStatus"
  | "archivedAt"
  | "blockedOnThreadWait"
  | "deletedAt"
  | "latestRunBackgroundWake"
  | "pendingBackgroundTasks"
  | "pendingGuestMessageCount"
  | "pendingRuntimeRequest"
  | "settledOverride"
  | "snoozedUntil"
  | "status"
  | "updatedAt"
>;

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

/** Pending input, approval, or guest message the owner already sees. */
export function threadAwaitsOwnerAttention(
  thread: Pick<ThreadStallShell, "pendingGuestMessageCount" | "pendingRuntimeRequest">,
): boolean {
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return true;
  const kind = thread.pendingRuntimeRequest?.kind;
  return kind !== undefined && kind !== "auth_refresh";
}

/**
 * Agent-side work that still needs progress: a live run, or background work that
 * holds the thread open. Inverse of settle-safe idle for the agent half.
 */
export function threadHasAgentOpenWork(
  thread: Pick<
    ThreadStallShell,
    "activityRunStatus" | "latestRunBackgroundWake" | "pendingBackgroundTasks" | "status"
  >,
): boolean {
  if ((thread.activityRunStatus ?? null) !== null) return true;
  if (LIVE_AGENT_STATUSES.has(thread.status)) return true;
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return true;
  return monitorHoldsWakeCompletion(thread);
}

function isStallCandidate(thread: ThreadStallShell): boolean {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
  if (thread.settledOverride === "settled") return false;
  if (threadAwaitsOwnerAttention(thread)) return false;
  // Waiting on another thread is intentional; that child's stall surfaces there.
  if (thread.blockedOnThreadWait === true) return false;
  return threadHasAgentOpenWork(thread);
}

/** When a stall candidate would cross the quiet threshold, or null if it cannot stall. */
export function threadStallDeadlineMs(
  thread: ThreadStallShell,
  stallAfterMs: number = DEFAULT_THREAD_STALL_AFTER_MS,
): number | null {
  if (!isStallCandidate(thread)) return null;
  const updatedAtMs = toMillis(thread.updatedAt);
  if (updatedAtMs === null) return null;
  return updatedAtMs + stallAfterMs;
}

/**
 * Open agent work that has gone quiet: not waiting on the owner, and no shell
 * update within `stallAfterMs`. Complements auto-settle (idle-complete) by
 * surfacing the inverse: stopped or frozen with work still open.
 */
export function isThreadStalled(
  thread: ThreadStallShell,
  nowMs: number,
  stallAfterMs: number = DEFAULT_THREAD_STALL_AFTER_MS,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs !== null && snoozedUntilMs > nowMs) return false;
  const deadlineMs = threadStallDeadlineMs(thread, stallAfterMs);
  return deadlineMs !== null && nowMs >= deadlineMs;
}
