import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { DateTime } from "effect";

/**
 * One status per thread row, shared by the web sidebar and the mobile thread list so a thread
 * reads the same on every device. Unread completion ("Done") is tracked separately: it says
 * whether a ready thread needs attention, not what the thread is doing.
 */
export type ThreadListStatus = "approval" | "input" | "working" | "monitoring" | "failed" | "ready";

type ThreadListStatusInput = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness"
>;

export function resolveThreadListStatus(thread: ThreadListStatusInput): ThreadListStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  // A failed session outranks lingering background liveness: the user must
  // see the failure, not a stale Working.
  if (thread.session?.status === "error") {
    return "failed";
  }
  // Background work outlives the turn: fleets read as working; monitoring
  // only when watch loops are the sole live work.
  if (thread.backgroundLiveness === "working") {
    return "working";
  }
  if (thread.backgroundLiveness === "monitoring") {
    return "monitoring";
  }
  return "ready";
}

/**
 * True when the latest turn finished after the reader last opened the thread. A thread never
 * opened on this device counts as read, so a device that has just started tracking visits does
 * not light up every settled thread at once. An unreadable visit stamp counts as unread.
 */
export function hasUnseenCompletion(
  thread: Pick<OrchestrationThreadShell, "latestTurn">,
  lastVisitedAt: string | null | undefined,
): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!lastVisitedAt) return false;

  const lastVisitedAtMs = Date.parse(lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return completedAt > lastVisitedAtMs;
}

/**
 * What a visit stamps: the latest completion when there is one, so the label clears exactly the
 * completion the reader saw and a later completion still signals. With no completion yet (a
 * fresh thread, or its first turn still running) the stamp is the running turn's request time,
 * or the thread's last server update, so a thread the reader started and walked away from still
 * lights up when its first turn finishes. Every candidate is a server clock: a client clock that
 * runs ahead of the server would outrank a completion that lands seconds later and hide it.
 */
export function resolveThreadVisitStamp(
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "updatedAt">,
): string {
  return thread.latestTurn?.completedAt ?? thread.latestTurn?.requestedAt ?? thread.updatedAt;
}

/** The timestamp a working thread's elapsed label counts from: the running
    turn's start (request time until adoption), falling back to the session's
    last transition when the turn projection lags behind. Malformed
    timestamps fall through to the next candidate, not just missing ones. */
export function resolveWorkingStartedAt(
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "session">,
): string | null {
  const turn = thread.latestTurn;
  if (turn && turn.completedAt === null) {
    return firstValidTimestamp(turn.startedAt, turn.requestedAt, thread.session?.updatedAt);
  }
  return firstValidTimestamp(thread.session?.updatedAt);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

/** Last-visited stamps keyed by scoped thread key. Device-local: the server keeps no read state. */
export type ThreadVisitsById = Readonly<Record<string, string>>;

/**
 * Records a visit stamped at the completion the reader saw, not at "now", so a completion that
 * lands later still gets its signal. Never moves a stamp backwards. Returns the same object when
 * nothing changes so callers can skip a write.
 */
export function withThreadVisited(
  visits: ThreadVisitsById,
  threadKey: string,
  visitedAt: string,
): ThreadVisitsById {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) {
    return visits;
  }
  const previousVisitedAt = visits[threadKey];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : Number.NaN;
  if (Number.isFinite(previousVisitedAtMs) && previousVisitedAtMs >= visitedAtMs) {
    return visits;
  }
  return { ...visits, [threadKey]: visitedAt };
}

/** Puts the visit stamp just before the latest completion so the thread reads as unread again. */
export function withThreadMarkedUnread(
  visits: ThreadVisitsById,
  threadKey: string,
  latestTurnCompletedAt: string | null | undefined,
): ThreadVisitsById {
  if (!latestTurnCompletedAt) {
    return visits;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return visits;
  }
  const unreadVisitedAt = DateTime.formatIso(DateTime.makeUnsafe(latestTurnCompletedAtMs - 1));
  if (visits[threadKey] === unreadVisitedAt) {
    return visits;
  }
  return { ...visits, [threadKey]: unreadVisitedAt };
}
