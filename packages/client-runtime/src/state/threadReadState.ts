import { DateTime } from "effect";

export function hasUnseenThreadCompletion(
  thread: {
    readonly latestTurn?: {
      readonly state?: string;
      readonly completedAt?: string | null;
    } | null;
  },
  lastVisitedAt: string | undefined,
): boolean {
  if (
    thread.latestTurn?.state === "running" ||
    !thread.latestTurn?.completedAt ||
    lastVisitedAt === undefined
  ) {
    return false;
  }
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  const visitedAt = Date.parse(lastVisitedAt);
  if (Number.isNaN(visitedAt)) return true;
  return completedAt > visitedAt;
}

export function resolveThreadVisitedAt(
  previousVisitedAt: string | undefined,
  visitedAt: string | null | undefined,
): string | undefined {
  if (!visitedAt) return previousVisitedAt;
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) return previousVisitedAt;
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (Number.isFinite(previousVisitedAtMs) && previousVisitedAtMs >= visitedAtMs) {
    return previousVisitedAt;
  }
  return visitedAt;
}

export function resolveThreadUnreadAt(
  latestTurnCompletedAt: string | null | undefined,
): string | undefined {
  if (!latestTurnCompletedAt) return undefined;
  const completedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(completedAtMs)) return undefined;
  return DateTime.formatIso(DateTime.makeUnsafe(completedAtMs - 1));
}
