import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type Project,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale"
  | "woke";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly retained?: boolean;
  readonly unread?: boolean;
  readonly completedAt?: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export interface ProjectThreadAwarenessV2Input {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<Project, "title">;
  readonly now?: number;
  readonly thread: Partial<
    Pick<
      OrchestrationV2ThreadShell,
      "archivedAt" | "snoozedUntil" | "snoozedAt" | "latestRunCompletedAt" | "lastVisitedAt"
    >
  > &
    Pick<
      OrchestrationV2ThreadShell,
      | "activityRunStatus"
      | "id"
      | "lineage"
      | "latestRunStopRequested"
      | "modelSelection"
      | "pendingBackgroundTasks"
      | "pendingRuntimeRequest"
      | "settledOverride"
      | "status"
      | "title"
      | "updatedAt"
    >;
}

export function projectThreadAwarenessV2(
  input: ProjectThreadAwarenessV2Input,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  if (
    !isListedThreadLineage(thread.lineage) ||
    thread.archivedAt != null ||
    thread.settledOverride === "settled"
  )
    return null;
  if (
    input.now !== undefined &&
    thread.snoozedUntil != null &&
    DateTime.toEpochMillis(thread.snoozedUntil) > input.now
  ) {
    const failedAfterSnooze =
      (thread.activityRunStatus ?? thread.status) === "failed" &&
      (thread.snoozedAt == null ||
        (thread.latestRunCompletedAt != null &&
          DateTime.toEpochMillis(thread.latestRunCompletedAt) >
            DateTime.toEpochMillis(thread.snoozedAt)));
    if (thread.pendingRuntimeRequest == null && !failedAfterSnooze) return null;
  }
  const snoozeWakeAt = thread.snoozedUntil;
  const woke =
    input.now !== undefined &&
    snoozeWakeAt != null &&
    DateTime.toEpochMillis(snoozeWakeAt) <= input.now &&
    (thread.lastVisitedAt == null ||
      DateTime.toEpochMillis(thread.lastVisitedAt) < DateTime.toEpochMillis(snoozeWakeAt)) &&
    (thread.latestRunCompletedAt == null ||
      DateTime.toEpochMillis(thread.latestRunCompletedAt) < DateTime.toEpochMillis(snoozeWakeAt));
  const runPhase = resolveThreadAwarenessPhaseV2(thread);
  const phase = woke && (runPhase === null || runPhase === "completed") ? "woke" : runPhase;
  if (phase === null) {
    return null;
  }
  if (phase === "completed" && thread.latestRunStopRequested === true) return null;
  const completedAt =
    phase === "completed" || phase === "failed" ? thread.latestRunCompletedAt : null;
  const unread =
    (phase === "completed" || phase === "failed") &&
    (thread.lastVisitedAt == null
      ? phase === "failed"
      : completedAt != null &&
        DateTime.toEpochMillis(completedAt) > DateTime.toEpochMillis(thread.lastVisitedAt));
  const detail =
    phase === "completed"
      ? "Review the completed task."
      : phase === "failed"
        ? "The agent run failed."
        : undefined;
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase),
    retained: true,
    unread,
    ...(completedAt == null ? {} : { completedAt: DateTime.formatIso(completedAt) }),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: DateTime.formatIso(
      phase === "woke" && snoozeWakeAt != null ? snoozeWakeAt : thread.updatedAt,
    ),
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhaseV2(
  thread: ProjectThreadAwarenessV2Input["thread"],
): AgentAwarenessPhase | null {
  if (thread.pendingRuntimeRequest?.kind === "user_input") return "waiting_for_input";
  if (
    thread.pendingRuntimeRequest !== null &&
    thread.pendingRuntimeRequest.kind !== "auth_refresh"
  ) {
    return "waiting_for_approval";
  }
  switch (thread.activityRunStatus ?? thread.status) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
        ? "running"
        : "completed";
    case "failed":
      return "failed";
    case "idle":
    case "queued":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return null;
  }
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
    case "woke":
      return "Snooze ended";
  }
}
