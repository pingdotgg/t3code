import type { DelegationAuditEvent, ThreadId } from "@t3tools/contracts";

export interface DelegationCleanupIntent {
  readonly attemptId: string;
  readonly childThreadId: ThreadId;
  readonly cleanupRequested: boolean;
}

const CHILD_LIFECYCLE_EVENTS = new Set<DelegationAuditEvent["eventType"]>([
  "thread.create.requested",
  "thread.created",
  "turn.start.rejected",
  "thread.delete.requested",
  "thread.deletion.accepted",
  "thread.deletion.failed",
  "cleanup.requested",
  "cleanup.queued",
  "cleanup.started",
  "cleanup.completed",
  "cleanup.failed",
  "cleanup.cancelled",
]);

const CLEANUP_TRANSITION_EVENTS = new Set<DelegationAuditEvent["eventType"]>([
  "cleanup.requested",
  "cleanup.queued",
  "cleanup.started",
  "cleanup.completed",
  "cleanup.failed",
  "cleanup.cancelled",
]);

const readCleanupWorktree = (payload: unknown): boolean | undefined => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const values = payload as Record<string, unknown>;
  const value = values.cleanupRequested ?? values.cleanupWorktree;
  return typeof value === "boolean" ? value : undefined;
};

export const deriveDelegationCleanupIntents = (
  events: ReadonlyArray<DelegationAuditEvent>,
): ReadonlyArray<DelegationCleanupIntent> => {
  const attempts = new Map<
    string,
    { childThreadId: ThreadId; cleanupRequested: boolean; cleanupIntentKnown: boolean }
  >();

  for (const event of events) {
    if (
      event.attemptId === null ||
      event.childThreadId === null ||
      !CHILD_LIFECYCLE_EVENTS.has(event.eventType)
    ) {
      continue;
    }

    let attempt = attempts.get(event.attemptId);
    if (attempt === undefined) {
      attempt = {
        childThreadId: event.childThreadId,
        cleanupRequested: false,
        cleanupIntentKnown: false,
      };
      attempts.set(event.attemptId, attempt);
    }
    if (attempt.cleanupIntentKnown) continue;

    if (CLEANUP_TRANSITION_EVENTS.has(event.eventType)) {
      attempt.cleanupRequested = true;
      attempt.cleanupIntentKnown = true;
      continue;
    }
    if (
      event.eventType === "thread.delete.requested" ||
      event.eventType === "thread.deletion.accepted" ||
      event.eventType === "thread.deletion.failed"
    ) {
      const cleanupWorktree = readCleanupWorktree(event.payload);
      if (cleanupWorktree !== undefined) {
        attempt.cleanupRequested = cleanupWorktree;
        attempt.cleanupIntentKnown = true;
      }
    }
  }

  return Array.from(attempts, ([attemptId, attempt]) => ({
    attemptId,
    childThreadId: attempt.childThreadId,
    cleanupRequested: attempt.cleanupRequested,
  }));
};
