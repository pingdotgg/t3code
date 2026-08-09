export type ThreadLastVisitedAtById = Readonly<Record<string, string>>;

export function hasUnseenThreadCompletion(
  thread: { readonly latestTurn?: { readonly completedAt?: string | null } | null },
  lastVisitedAt: string | undefined,
): boolean {
  if (!thread.latestTurn?.completedAt || lastVisitedAt === undefined) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  const visitedAt = Date.parse(lastVisitedAt);
  if (Number.isNaN(visitedAt)) return true;
  return completedAt > visitedAt;
}

export function setThreadVisitedAt(
  current: ThreadLastVisitedAtById,
  threadKey: string,
  visitedAt: string | null | undefined,
): ThreadLastVisitedAtById {
  if (!visitedAt) return current;
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) return current;
  const previousVisitedAt = current[threadKey];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (Number.isFinite(previousVisitedAtMs) && previousVisitedAtMs >= visitedAtMs) return current;
  return { ...current, [threadKey]: visitedAt };
}

export function setThreadUnreadAt(
  current: ThreadLastVisitedAtById,
  threadKey: string,
  latestTurnCompletedAt: string | null | undefined,
): ThreadLastVisitedAtById {
  if (!latestTurnCompletedAt) return current;
  const completedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(completedAtMs)) return current;
  const unreadVisitedAt = new Date(completedAtMs - 1).toISOString();
  if (current[threadKey] === unreadVisitedAt) return current;
  return { ...current, [threadKey]: unreadVisitedAt };
}
