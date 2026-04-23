import type {
  NotificationEventGroup,
  OrchestrationEvent,
  OrchestrationSessionStatus,
  ProjectId,
  ThreadId,
  TurnId,
} from "@marcode/contracts";
import type { Project, Thread } from "./types";

export type TurnNotificationReason =
  | "turn-completed"
  | "turn-interrupted"
  | "turn-stopped"
  | "turn-errored"
  | "approval-requested"
  | "user-input-requested";

export interface TurnNotificationTrigger {
  threadId: ThreadId;
  reason: TurnNotificationReason;
  threadTitle: string;
  projectName: string;
}

export interface BuiltInSound {
  readonly id: string;
  readonly label: string;
  readonly src: string;
}

export const BUILT_IN_SOUNDS: readonly BuiltInSound[] = [
  { id: "gentle-chime", label: "Gentle chime", src: "/sounds/gentle-chime.mp3" },
  { id: "pop", label: "Pop", src: "/sounds/pop.mp3" },
  { id: "bell", label: "Bell", src: "/sounds/bell.mp3" },
  { id: "success", label: "Success", src: "/sounds/success.mp3" },
] as const;

const COMPLETION_STATUS_TO_REASON: Partial<
  Record<OrchestrationSessionStatus, TurnNotificationReason>
> = {
  idle: "turn-completed",
  ready: "turn-completed",
  interrupted: "turn-interrupted",
  stopped: "turn-stopped",
  error: "turn-errored",
};

const USER_INITIATED_STATUSES: ReadonlySet<OrchestrationSessionStatus> = new Set([
  "stopped",
  "interrupted",
]);

const SUPPRESSION_WINDOW_MS = 5_000;
const suppressedThreads = new Map<ThreadId, number>();

export function markThreadUserStopped(threadId: ThreadId): void {
  suppressedThreads.set(threadId, Date.now());
}

function isThreadSuppressed(threadId: ThreadId): boolean {
  const suppressedAt = suppressedThreads.get(threadId);
  if (suppressedAt === undefined) return false;
  if (Date.now() - suppressedAt > SUPPRESSION_WINDOW_MS) {
    suppressedThreads.delete(threadId);
    return false;
  }
  return true;
}

// Persistent per-thread flag: true while a turn is running. The shell stream and
// the detail stream can race each other — by the time a "ready" status arrives
// in one stream, the stored session may already read "ready" from the other, so
// we can't rely on reading `thread.session?.orchestrationStatus` to decide
// whether a turn *was* active. This set is authoritative across batches.
const threadsWithActiveTurn = new Set<ThreadId>();

// Persistent recent-completion dedup. `thread.session-set` (ready) and
// `thread.turn-diff-completed` arrive as two separate single-event batches in
// normal operation; batch-local dedup wouldn't coalesce them. Cross-batch dedup
// with a short TTL ensures one sound per real turn end.
const COMPLETION_DEDUP_WINDOW_MS = 3_000;
const recentlyFiredCompletion = new Map<ThreadId, number>();

function wasRecentlyFired(threadId: ThreadId): boolean {
  const firedAt = recentlyFiredCompletion.get(threadId);
  if (firedAt === undefined) return false;
  if (Date.now() - firedAt > COMPLETION_DEDUP_WINDOW_MS) {
    recentlyFiredCompletion.delete(threadId);
    return false;
  }
  return true;
}

function markCompletionFired(threadId: ThreadId): void {
  recentlyFiredCompletion.set(threadId, Date.now());
}

/**
 * Test-only: reset the module's persistent notification state. Call between
 * `deriveTurnNotificationTriggers` test cases to ensure isolation.
 */
export function __resetTurnNotificationStateForTests(): void {
  threadsWithActiveTurn.clear();
  recentlyFiredCompletion.clear();
  suppressedThreads.clear();
}

// Tracks turn ids the user has locally interrupted via the Stop button, so the
// in-chat "Working…" indicator can clear immediately without waiting for a
// provider-emitted turn.completed event (which may be slow, dropped, or hang).
// Scoped per-turnId so a follow-up message starts a new turn with a new id
// that is NOT in this set — the indicator re-appears correctly on send.
// Snapshot is swapped (not mutated) on write so React's useSyncExternalStore
// detects the change via reference equality.
let locallyInterruptedTurnIds: ReadonlySet<TurnId> = new Set();
const locallyInterruptedListeners = new Set<() => void>();

export function markTurnLocallyInterrupted(turnId: TurnId): void {
  if (locallyInterruptedTurnIds.has(turnId)) return;
  locallyInterruptedTurnIds = new Set([...locallyInterruptedTurnIds, turnId]);
  for (const listener of locallyInterruptedListeners) listener();
}

export function subscribeToLocallyInterruptedTurns(listener: () => void): () => void {
  locallyInterruptedListeners.add(listener);
  return () => {
    locallyInterruptedListeners.delete(listener);
  };
}

export function getLocallyInterruptedTurnsSnapshot(): ReadonlySet<TurnId> {
  return locallyInterruptedTurnIds;
}

export function isTurnLocallyInterrupted(turnId: TurnId): boolean {
  return locallyInterruptedTurnIds.has(turnId);
}

export function deriveTurnNotificationTriggers(
  events: readonly OrchestrationEvent[],
  getThread: (threadId: ThreadId) => Thread | undefined,
  getProject: (projectId: ProjectId) => Project | undefined,
): TurnNotificationTrigger[] {
  const triggers: TurnNotificationTrigger[] = [];

  const userInitiatedThreadIds = new Set<ThreadId>();
  for (const event of events) {
    if (
      event.type === "thread.session-set" &&
      USER_INITIATED_STATUSES.has(event.payload.session.status)
    ) {
      userInitiatedThreadIds.add(event.payload.threadId);
    }
  }

  // Threads that already produced a completion trigger in this batch. Used to
  // dedupe between the primary session-set signal and the turn-diff-completed
  // fallback so we never fire two notifications for the same turn end.
  const completionFiredThreadIds = new Set<ThreadId>();

  for (const event of events) {
    if (event.type === "thread.session-set") {
      const { threadId, session } = event.payload;
      const newStatus = session.status;

      if (newStatus === "running") {
        // Arm the persistent active-turn flag. Cleared on completion below.
        threadsWithActiveTurn.add(threadId);
      }

      const reason = COMPLETION_STATUS_TO_REASON[newStatus];
      if (!reason) continue;

      if (userInitiatedThreadIds.has(threadId) && !USER_INITIATED_STATUSES.has(newStatus)) continue;

      if (isThreadSuppressed(threadId)) continue;

      // STRICT GATE: only fire if we observed a `running` session-set event
      // earlier (in this batch or a prior one). This is the single signal that
      // a real turn actually started. Previous heuristics (stored
      // orchestrationStatus / activeTurnId / latestTurn) all had failure modes
      // where session.started's status=ready + stale store state misfired for
      // OpenCode/Cursor — the flag below is authoritative.
      if (!threadsWithActiveTurn.has(threadId)) continue;

      const thread = getThread(threadId);
      if (!thread) continue;

      if (wasRecentlyFired(threadId)) {
        // Another event in the prior ~3s already fired this turn's completion
        // (e.g. session-set from the detail stream + a stray shell-stream echo).
        threadsWithActiveTurn.delete(threadId);
        completionFiredThreadIds.add(threadId);
        continue;
      }

      const project = getProject(thread.projectId);
      triggers.push({
        threadId,
        reason,
        threadTitle: thread.title || "Untitled",
        projectName: project?.name || "Unknown project",
      });
      completionFiredThreadIds.add(threadId);
      threadsWithActiveTurn.delete(threadId);
      markCompletionFired(threadId);
      continue;
    }

    // Fallback signal: a turn-diff capture completing is a strong guarantee
    // that a turn ended — CheckpointReactor only fires this after an actual
    // turn.completed runtime event. Still gated on the armed flag so we never
    // notify for a turn that never started from the client's perspective.
    if (event.type === "thread.turn-diff-completed") {
      const { threadId } = event.payload;
      if (completionFiredThreadIds.has(threadId)) continue;
      if (isThreadSuppressed(threadId)) continue;
      if (userInitiatedThreadIds.has(threadId)) continue;
      if (!threadsWithActiveTurn.has(threadId)) continue;
      if (wasRecentlyFired(threadId)) {
        // The primary session-set path already fired in a nearby batch.
        completionFiredThreadIds.add(threadId);
        continue;
      }
      const thread = getThread(threadId);
      if (!thread) continue;
      const project = getProject(thread.projectId);
      triggers.push({
        threadId,
        reason: "turn-completed",
        threadTitle: thread.title || "Untitled",
        projectName: project?.name || "Unknown project",
      });
      completionFiredThreadIds.add(threadId);
      threadsWithActiveTurn.delete(threadId);
      markCompletionFired(threadId);
      continue;
    }

    if (event.type === "thread.activity-appended") {
      const { threadId, activity } = event.payload;
      const kind = activity.kind;

      let reason: TurnNotificationReason | undefined;
      if (kind === "approval.requested") {
        reason = "approval-requested";
      } else if (kind === "user-input.requested") {
        reason = "user-input-requested";
      }
      if (!reason) continue;

      const thread = getThread(threadId);
      if (!thread) continue;
      const project = getProject(thread.projectId);
      triggers.push({
        threadId,
        reason,
        threadTitle: thread.title || "Untitled",
        projectName: project?.name || "Unknown project",
      });
    }
  }

  return triggers;
}

const REASON_TITLES: Record<TurnNotificationReason, string> = {
  "turn-completed": "Turn completed",
  "turn-interrupted": "Turn interrupted",
  "turn-stopped": "Turn stopped",
  "turn-errored": "Turn failed",
  "approval-requested": "Approval needed",
  "user-input-requested": "Input needed",
};

const REASON_TO_EVENT_GROUP: Record<TurnNotificationReason, NotificationEventGroup> = {
  "turn-completed": "turn-events",
  "turn-interrupted": "turn-events",
  "turn-stopped": "turn-events",
  "turn-errored": "turn-events",
  "approval-requested": "approval-needed",
  "user-input-requested": "user-input-needed",
};

export function reasonToEventGroup(reason: TurnNotificationReason): NotificationEventGroup {
  return REASON_TO_EVENT_GROUP[reason];
}

export function buildNotificationContent(trigger: TurnNotificationTrigger): {
  title: string;
  body: string;
} {
  return {
    title: REASON_TITLES[trigger.reason],
    body: `"${trigger.threadTitle}" \u2014 ${trigger.projectName}`,
  };
}
