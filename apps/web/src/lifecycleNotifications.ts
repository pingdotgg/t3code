import { type Project, type Thread } from "./types";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  isLatestTurnSettled,
} from "./session-logic";

export type NotificationThreadSnapshot = Pick<
  Thread,
  "id" | "projectId" | "title" | "activities" | "latestTurn" | "session"
>;
export type NotificationProjectSnapshot = Pick<Project, "id" | "name">;

export interface LifecycleNotificationEvent {
  id: string;
  kind: "approval-requested" | "turn-completed" | "user-input-requested";
  title: string;
  body: string;
  threadId: Thread["id"];
}

function formatThreadTarget(
  thread: NotificationThreadSnapshot,
  projectName: string | undefined,
): string {
  return projectName ? `${projectName} · ${thread.title}` : thread.title;
}

export function cloneThreadSnapshot(
  thread: NotificationThreadSnapshot,
): NotificationThreadSnapshot {
  return {
    ...thread,
    activities: thread.activities.map((activity) => ({ ...activity })),
    latestTurn: thread.latestTurn ? { ...thread.latestTurn } : null,
    session: thread.session ? { ...thread.session } : null,
  };
}

export function collectLifecycleNotifications(input: {
  previousThreads: ReadonlyArray<NotificationThreadSnapshot>;
  nextThreads: ReadonlyArray<NotificationThreadSnapshot>;
  projects: ReadonlyArray<NotificationProjectSnapshot>;
}): LifecycleNotificationEvent[] {
  const previousByThreadId = new Map(
    input.previousThreads.map((thread) => [thread.id, thread] as const),
  );
  const projectNameById = new Map(
    input.projects.map((project) => [project.id, project.name] as const),
  );
  const notifications: LifecycleNotificationEvent[] = [];

  for (const thread of input.nextThreads) {
    const previousThread = previousByThreadId.get(thread.id) ?? null;
    const threadTarget = formatThreadTarget(thread, projectNameById.get(thread.projectId));

    const previousPendingApprovals = new Set(
      derivePendingApprovals(previousThread?.activities ?? []).map(
        (approval) => approval.requestId,
      ),
    );
    const newApprovals = derivePendingApprovals(thread.activities).filter(
      (approval) => !previousPendingApprovals.has(approval.requestId),
    );
    for (const approval of newApprovals) {
      notifications.push({
        id: `approval:${thread.id}:${approval.requestId}`,
        kind: "approval-requested",
        title: "Approval needed",
        body: `Agent needs approval in ${threadTarget}.`,
        threadId: thread.id,
      });
    }

    const previousPendingUserInputs = new Set(
      derivePendingUserInputs(previousThread?.activities ?? []).map((request) => request.requestId),
    );
    const newUserInputs = derivePendingUserInputs(thread.activities).filter(
      (request) => !previousPendingUserInputs.has(request.requestId),
    );
    for (const request of newUserInputs) {
      notifications.push({
        id: `user-input:${thread.id}:${request.requestId}`,
        kind: "user-input-requested",
        title: "Input needed",
        body: `Agent is waiting for your input in ${threadTarget}.`,
        threadId: thread.id,
      });
    }

    if (newApprovals.length > 0 || newUserInputs.length > 0) {
      continue;
    }

    const latestTurn = thread.latestTurn;
    if (
      !latestTurn ||
      latestTurn.state !== "completed" ||
      !latestTurn.completedAt ||
      !isLatestTurnSettled(latestTurn, thread.session)
    ) {
      continue;
    }

    const previousLatestTurn = previousThread?.latestTurn ?? null;
    const previousCompletion =
      previousLatestTurn?.turnId === latestTurn.turnId ? previousLatestTurn.completedAt : null;
    const previousSettled = previousLatestTurn
      ? isLatestTurnSettled(previousLatestTurn, previousThread?.session ?? null)
      : false;

    if (previousSettled && previousCompletion === latestTurn.completedAt) {
      continue;
    }

    notifications.push({
      id: `turn-completed:${thread.id}:${latestTurn.turnId}:${latestTurn.completedAt}`,
      kind: "turn-completed",
      title: "Turn completed",
      body: `Agent finished work in ${threadTarget}.`,
      threadId: thread.id,
    });
  }

  return notifications;
}
