import type {
  DesktopNotificationRequest,
  DesktopThreadCompletionNotificationStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import type { EnvironmentState } from "./store";
import type { ThreadCompletionNotificationMode } from "@t3tools/contracts/settings";

export interface ThreadCompletionNotificationTracker {
  readonly notifiedTurnKeys: Set<string>;
  readonly bootstrappedEnvironmentIds: Set<string>;
}

export interface ThreadCompletionNotificationInput {
  readonly environmentStateById: Readonly<Record<string, EnvironmentState>>;
  readonly notificationMode: ThreadCompletionNotificationMode;
  readonly activeThreadKey: string | null;
  readonly isDocumentFocused: boolean;
  readonly tracker: ThreadCompletionNotificationTracker;
}

export function collectThreadCompletionNotifications(
  input: ThreadCompletionNotificationInput,
): DesktopNotificationRequest[] {
  const requests: DesktopNotificationRequest[] = [];

  for (const [environmentId, environmentState] of Object.entries(input.environmentStateById)) {
    const candidates = Object.values(environmentState.sidebarThreadSummaryById).flatMap(
      (summary) => {
        const latestTurn = summary.latestTurn;
        if (!latestTurn || !latestTurn.completedAt) {
          return [];
        }

        const status = notificationStatusFromTurnState(latestTurn.state);
        if (!status) {
          return [];
        }

        return [
          {
            summary,
            latestTurn,
            completedAt: latestTurn.completedAt,
            status,
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

      input.tracker.notifiedTurnKeys.add(candidate.turnKey);
      if (
        isFirstCompletedBootstrap ||
        input.notificationMode === "off" ||
        (input.notificationMode === "background-only" &&
          input.isDocumentFocused &&
          input.activeThreadKey === `${candidate.summary.environmentId}:${candidate.summary.id}`)
      ) {
        continue;
      }

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

  return requests;
}

export function notificationStatusFromTurnState(
  state: string,
): DesktopThreadCompletionNotificationStatus | null {
  switch (state) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
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
