import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { threadShellHasActiveWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  threadHasPullRequestWatch,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import type * as ProjectionStore from "./ProjectionStore.ts";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

function latestMillis(values: ReadonlyArray<number | null>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

/**
 * A recent user message stays queued until a run adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. A failed run start
 * clears the block immediately (mirrors the v1 session "error" rule).
 */
export function threadHasQueuedTurnStart(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
): boolean {
  const messageAtMs = toMillis(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
}

/** Reject busy and explicitly parked cards before applying their idle period. */
export function isAutoSettlementCandidate(
  thread: Omit<ProjectionStore.ProjectionSettlementCandidate, "latestUserAuthoredMessageAt">,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride === "settled") return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  // Blocked-on-you work must never park behind a settled override.
  if (thread.pendingRuntimeRequest !== null || (thread.pendingGuestMessageCount ?? 0) > 0)
    return false;
  // A live run, or background work that will wake the agent, is not
  // staleness. A dev server left running is: the agent is done.
  if (threadShellHasActiveWork(thread)) return false;
  // Settling would suspend the watch, so the agent would never hear about its pull request.
  // Manual settlement still parks it deliberately.
  if (threadHasPullRequestWatch(thread)) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  // Interrupted runs must keep the same snooze protection the sidebar shows.
  return !isSnoozed(thread, nowMs);
}

/**
 * Whether a settled thread has stayed settled long enough to archive. The clock is the thread's
 * own settle time, which unarchiving restarts; folders, worktrees and other environments play
 * no part.
 */
export function isAutoArchiveDue(
  thread: ProjectionStore.ProjectionSettlementCandidate,
  input: { readonly nowMs: number; readonly afterDays: number },
): boolean {
  if (input.afterDays <= 0 || thread.settledAt === null) return false;
  return (
    DateTime.toEpochMillis(thread.settledAt) <= input.nowMs - input.afterDays * DAY_MS &&
    isAutoArchiveCandidate(thread, input.nowMs)
  );
}

/** Anything still waiting on the thread, or on the user, keeps it out of the archive. */
export function isAutoArchiveCandidate(
  thread: ProjectionStore.ProjectionSettlementCandidate,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== "settled") return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  if (thread.pendingRuntimeRequest !== null || (thread.pendingGuestMessageCount ?? 0) > 0)
    return false;
  if (threadShellHasActiveWork(thread) || threadHasPullRequestWatch(thread)) return false;
  // Archiving drops the pull request from every list the user scans for review work.
  if (
    visibleThreadPullRequests(thread.pullRequests ?? []).some(
      (link) => link.snapshot?.state === "open",
    )
  )
    return false;
  return !isSnoozed(thread, nowMs);
}

export function resolveAutoSettlementAt(input: {
  readonly thread: ProjectionStore.ProjectionSettlementCandidate;
  readonly nowMs: number;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleKeepPullRequests?: boolean;
}): DateTime.Utc | null {
  if (input.autoSettleAfterDays === null || input.autoSettleAfterDays <= 0) return null;
  return resolveIdleSince(input, input.autoSettleAfterDays * DAY_MS);
}

/**
 * When a child chat that finished its work settles: it has a parent, its last run completed (or
 * it never ran), and nothing about it changed for the period. A failed or interrupted child is
 * not done; it waits for someone to look at it under the age rule instead.
 */
export function resolveFinishedChildSettlementAt(input: {
  readonly thread: ProjectionStore.ProjectionSettlementCandidate;
  readonly nowMs: number;
  readonly afterHours: number;
  readonly autoSettleKeepPullRequests?: boolean;
}): DateTime.Utc | null {
  if (input.afterHours <= 0 || !isFinishedChild(input.thread)) return null;
  return resolveIdleSince(input, input.afterHours * HOUR_MS);
}

export function isFinishedChild(
  thread: Pick<ProjectionStore.ProjectionSettlementCandidate, "parentThreadId" | "status">,
): boolean {
  return (
    thread.parentThreadId != null && (thread.status === "completed" || thread.status === "idle")
  );
}

function resolveIdleSince(
  input: {
    readonly thread: ProjectionStore.ProjectionSettlementCandidate;
    readonly nowMs: number;
    readonly autoSettleKeepPullRequests?: boolean;
  },
  periodMs: number,
): DateTime.Utc | null {
  const { thread } = input;
  if (!isAutoSettlementCandidate(thread, input.nowMs)) return null;
  const hasPullRequest =
    (thread.pullRequests?.length ?? 0) > 0 ||
    thread.linkedPullRequest != null ||
    thread.branchPullRequest != null;
  if (input.autoSettleKeepPullRequests === true && hasPullRequest) return null;
  // A passed wake timer restarts inactivity. An earlier wake can only delay settlement.
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  const timerWakeAtMs =
    snoozedUntilMs !== null && snoozedUntilMs <= input.nowMs ? snoozedUntilMs : null;
  const activityAtMs = latestMillis([
    toMillis(thread.lastSnoozeWakeAt),
    timerWakeAtMs,
    toMillis(thread.createdAt),
    toMillis(thread.updatedAt),
    toMillis(thread.unsettledAt),
    toMillis(thread.lastVisitedAt),
    toMillis(thread.latestBackgroundActivityAt),
    toMillis(thread.latestUserMessageAt),
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ]);
  return activityAtMs !== null && activityAtMs <= input.nowMs - periodMs
    ? DateTime.makeUnsafe(activityAtMs)
    : null;
}

/** Match the client snooze: pending requests, waiting guests and fresh failures wake it; completion does not. */
export function isSnoozed(
  thread: Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "status"
    | "pendingRuntimeRequest"
    | "pendingGuestMessageCount"
  >,
  nowMs: number,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  if (thread.pendingRuntimeRequest !== null || (thread.pendingGuestMessageCount ?? 0) > 0)
    return false;
  const snoozedAtMs = toMillis(thread.snoozedAt);
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  return !wokeOnError;
}
