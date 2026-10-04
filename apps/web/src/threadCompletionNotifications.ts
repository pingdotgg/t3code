import type {
  DesktopNotificationRequest,
  DesktopThreadCompletionNotificationStatus,
  EnvironmentId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { EnvironmentState } from "./store";
import type { ThreadCompletionNotificationMode } from "@t3tools/contracts/settings";

export interface StaleActiveTurnToastRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly title: string;
  readonly threadTitle: string;
}

export interface ThreadCompletionNotificationTracker {
  readonly notifiedTurnKeys: Set<string>;
  readonly bootstrappedEnvironmentIds: Set<string>;
  readonly pendingInterruptedTurnKeys: Map<string, number>;
}

export const INTERRUPTED_NOTIFICATION_GRACE_MS = 1_000;

export interface ThreadCompletionNotificationInput {
  readonly environmentStateById: Readonly<Record<string, EnvironmentState>>;
  readonly notificationMode: ThreadCompletionNotificationMode;
  readonly activeThreadKey: string | null;
  readonly isDocumentFocused: boolean;
  readonly tracker: ThreadCompletionNotificationTracker;
  readonly now?: number;
}

export function collectThreadCompletionNotifications(
  input: ThreadCompletionNotificationInput,
): DesktopNotificationRequest[] {
  const requests: DesktopNotificationRequest[] = [];
  const now = input.now ?? Date.now();
  const candidateTurnKeys = new Set<string>();

  for (const [environmentId, environmentState] of Object.entries(input.environmentStateById)) {
    const candidates = Object.values(environmentState.sidebarThreadSummaryById).flatMap(
      (summary) => {
        const latestTurn = summary.latestTurn;
        if (!latestTurn || !latestTurn.completedAt) {
          return [];
        }

        const terminalStatus = notificationStatusFromTerminalActivity(
          environmentState.insightActivitiesByThreadId[summary.id],
          latestTurn.turnId,
        );
        const status = terminalStatus ?? notificationStatusFromTurnState(latestTurn.state);
        if (!status) {
          return [];
        }

        return [
          {
            summary,
            latestTurn,
            completedAt: latestTurn.completedAt,
            status,
            delayInterruption: terminalStatus === null,
            turnKey: `${summary.environmentId}:${summary.id}:${latestTurn.turnId}`,
          },
        ];
      },
    );

    const isFirstCompletedBootstrap = environmentState.bootstrapComplete
      ? !input.tracker.bootstrappedEnvironmentIds.has(environmentId)
      : true;
    for (const candidate of candidates) {
      if (input.tracker.notifiedTurnKeys.has(candidate.turnKey)) {
        continue;
      }

      // Shell-projected queue flag (handoff continuation or user follow-up).
      // Do not seed notifiedTurnKeys so a later true completion can still notify.
      if (candidate.summary.hasPendingQueuedTurn) {
        continue;
      }

      candidateTurnKeys.add(candidate.turnKey);
      // Delegated children report to their parent, which decides whether to alert the user.
      const parentSummary = candidate.summary.parentThreadId
        ? environmentState.sidebarThreadSummaryById[candidate.summary.parentThreadId]
        : undefined;
      if (
        isFirstCompletedBootstrap ||
        input.notificationMode === "off" ||
        (parentSummary !== undefined && parentSummary.archivedAt === null) ||
        (input.notificationMode === "background-only" &&
          input.isDocumentFocused &&
          input.activeThreadKey === `${candidate.summary.environmentId}:${candidate.summary.id}`)
      ) {
        input.tracker.pendingInterruptedTurnKeys.delete(candidate.turnKey);
        input.tracker.notifiedTurnKeys.add(candidate.turnKey);
        continue;
      }

      if (candidate.status === "interrupted" && candidate.delayInterruption) {
        const notifyAfter = input.tracker.pendingInterruptedTurnKeys.get(candidate.turnKey);
        if (notifyAfter === undefined) {
          input.tracker.pendingInterruptedTurnKeys.set(
            candidate.turnKey,
            now + INTERRUPTED_NOTIFICATION_GRACE_MS,
          );
          continue;
        }
        if (now < notifyAfter) {
          continue;
        }
      }

      input.tracker.pendingInterruptedTurnKeys.delete(candidate.turnKey);
      input.tracker.notifiedTurnKeys.add(candidate.turnKey);
      requests.push({
        kind: "thread-turn-completed",
        environmentId: candidate.summary.environmentId,
        threadId: candidate.summary.id,
        turnId: candidate.latestTurn.turnId,
        title: notificationTitleFromStatus(candidate.status),
        body: candidate.summary.title,
        status: candidate.status,
        createdAt: candidate.completedAt,
      });
    }

    if (environmentState.bootstrapComplete) {
      input.tracker.bootstrappedEnvironmentIds.add(environmentId as EnvironmentId);
    }
  }

  for (const turnKey of input.tracker.pendingInterruptedTurnKeys.keys()) {
    if (!candidateTurnKeys.has(turnKey)) {
      input.tracker.pendingInterruptedTurnKeys.delete(turnKey);
    }
  }

  return requests;
}

function notificationStatusFromTerminalActivity(
  activities: EnvironmentState["insightActivitiesByThreadId"][ThreadId] | undefined,
  turnId: TurnId,
): DesktopThreadCompletionNotificationStatus | null {
  if (!activities) {
    return null;
  }

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "insights.turn.completed" || activity.turnId !== turnId) {
      continue;
    }

    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    return normalizeNotificationStatus(payload?.state);
  }

  return null;
}

export function collectStaleActiveTurnToastRequests(input: {
  readonly environmentStateById: Readonly<Record<string, EnvironmentState>>;
  readonly notifiedTurnKeys: Set<string>;
}): StaleActiveTurnToastRequest[] {
  const requests: StaleActiveTurnToastRequest[] = [];

  for (const environmentState of Object.values(input.environmentStateById)) {
    if (!environmentState.bootstrapComplete) {
      continue;
    }

    for (const summary of Object.values(environmentState.sidebarThreadSummaryById)) {
      const latestTurn = summary.latestTurn;
      const session = summary.session;
      if (!latestTurn?.completedAt || !session?.activeTurnId) {
        continue;
      }
      if (session.activeTurnId !== latestTurn.turnId) {
        continue;
      }

      const turnKey = `${summary.environmentId}:${summary.id}:${latestTurn.turnId}`;
      if (input.notifiedTurnKeys.has(turnKey)) {
        continue;
      }

      input.notifiedTurnKeys.add(turnKey);
      requests.push({
        environmentId: summary.environmentId,
        threadId: summary.id,
        turnId: latestTurn.turnId,
        title: "Chat still looked active after completion",
        threadTitle: summary.title,
      });
    }
  }

  return requests;
}

export function notificationStatusFromTurnState(
  state: string,
): DesktopThreadCompletionNotificationStatus | null {
  return normalizeNotificationStatus(state);
}

function normalizeNotificationStatus(
  state: unknown,
): DesktopThreadCompletionNotificationStatus | null {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

export function notificationTitleFromStatus(
  status: DesktopThreadCompletionNotificationStatus,
): string {
  switch (status) {
    case "completed":
      return "Chat completed";
    case "failed":
      return "Chat failed";
    case "interrupted":
      return "Chat interrupted";
    case "cancelled":
      return "Chat cancelled";
  }
}
