import type { Thread } from "./types";

type TimestampedThreadInput = Pick<Thread, "lastVisitedAt">;

type UnseenCompletionThreadInput = Pick<Thread, "lastVisitedAt" | "latestTurn">;

type UnseenErrorThreadInput = Pick<
  Thread,
  "activities" | "lastVisitedAt" | "latestTurn" | "session"
>;

function parseIsoTimestamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function happenedAfterLastVisit(
  thread: TimestampedThreadInput,
  occurredAt: string | null | undefined,
): boolean {
  const occurredAtMs = parseIsoTimestamp(occurredAt);
  if (occurredAtMs === null) return false;

  const lastVisitedAtMs = parseIsoTimestamp(thread.lastVisitedAt);
  if (lastVisitedAtMs === null) return true;

  return occurredAtMs > lastVisitedAtMs;
}

export function hasUnseenCompletion(thread: UnseenCompletionThreadInput): boolean {
  return happenedAfterLastVisit(thread, thread.latestTurn?.completedAt);
}

export function hasUnseenError(thread: UnseenErrorThreadInput): boolean {
  const hasUnseenErrorActivity = thread.activities.some(
    (activity) => activity.tone === "error" && happenedAfterLastVisit(thread, activity.createdAt),
  );
  if (hasUnseenErrorActivity) {
    return true;
  }

  if (thread.latestTurn?.state === "error") {
    if (happenedAfterLastVisit(thread, thread.latestTurn.completedAt)) {
      return true;
    }
  }

  if (thread.session?.lastError) {
    if (happenedAfterLastVisit(thread, thread.session.updatedAt)) {
      return true;
    }
  }

  return false;
}
