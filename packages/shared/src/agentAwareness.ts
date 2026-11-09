import {
  isListedThreadLineage,
  type DesktopNotificationEvent,
  type EnvironmentId,
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type Project,
  type RuntimeRequestId,
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
  | "stale";

export interface SubagentRequestAwareness {
  readonly requestId: RuntimeRequestId;
  /** The child's own update time, which moves whenever its request changes. */
  readonly updatedAt: DateTime.Utc;
}

/** Provider-native subagents ask on their parent; the coordinator answers child questions. */
export function subagentAwaitsApproval(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "activityRunStatus" | "creationSource" | "lineage" | "pendingRuntimeRequest"
  >,
): boolean {
  const kind = thread.pendingRuntimeRequest?.kind;
  return (
    kind !== undefined &&
    kind !== "auth_refresh" &&
    kind !== "user_input" &&
    thread.lineage.relationshipToParent === "subagent" &&
    !isProviderNativeSubagentThread(thread) &&
    // The activity run stays set when a follow-up is queued behind a blocked run.
    thread.activityRunStatus != null
  );
}

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly notificationVersion: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface AgentNotificationContent {
  readonly title: string;
  readonly body: string;
}

const AGENT_NOTIFICATION_TITLE_BY_EVENT: Record<DesktopNotificationEvent, string> = {
  approval: "Approval needed",
  input: "Waiting for input",
  completion: "Agent finished",
  failure: "Agent failed",
};

const PRIVATE_AGENT_NOTIFICATION_BODY = "Open T3 Code to view details.";
const MAX_AGENT_NOTIFICATION_BODY_CHARACTERS = 160;
const MAX_AGENT_COMPLETION_PREVIEW_CHARACTERS = 90;

export function notificationEventForAwarenessTransition(
  previous: AgentAwarenessState | null,
  current: AgentAwarenessState | null,
): DesktopNotificationEvent | null {
  if (
    current === null ||
    (previous?.phase === current.phase &&
      previous.notificationVersion === current.notificationVersion)
  ) {
    return null;
  }

  switch (current.phase) {
    case "waiting_for_approval":
      return "approval";
    case "waiting_for_input":
      return "input";
    case "completed":
      return "completion";
    case "failed":
      return "failure";
    case "starting":
    case "running":
    case "stale":
      return null;
  }
}

/** Shared notification copy. Native and browser notifications receive these exact strings. */
export function formatAgentNotificationContent(input: {
  readonly event: DesktopNotificationEvent;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly showContext: boolean;
  readonly completionPreview?: string | null;
}): AgentNotificationContent {
  if (!input.showContext) {
    return {
      title: AGENT_NOTIFICATION_TITLE_BY_EVENT[input.event],
      body: PRIVATE_AGENT_NOTIFICATION_BODY,
    };
  }

  if (input.event === "completion") {
    return {
      title: input.threadTitle.trim(),
      body:
        formatAgentCompletionPreview(input.completionPreview ?? "") ??
        truncateNotificationText(
          `Finished · ${input.projectTitle.trim()}`,
          MAX_AGENT_COMPLETION_PREVIEW_CHARACTERS,
        ),
    };
  }

  return {
    title: AGENT_NOTIFICATION_TITLE_BY_EVENT[input.event],
    body: truncateNotificationText(
      `${input.threadTitle.trim()} · ${input.projectTitle.trim()}`,
      MAX_AGENT_NOTIFICATION_BODY_CHARACTERS,
    ),
  };
}

/** Turns a final assistant response into compact plain text suitable for native notifications. */
export function formatAgentCompletionPreview(response: string): string | null {
  const normalized = response
    .split(/\r?\n/u)
    .map((line) =>
      line
        .trim()
        .replace(/^```.*$/u, "")
        .replace(/^(?:#{1,6}|>|[-*+])\s+/u, "")
        .replace(/\[([^\]]+)\]\([^\s)]+\)/gu, "$1")
        .replace(/(\*\*|__|~~)(.+?)\1/gu, "$2")
        .replace(/`([^`]+)`/gu, "$1")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0
    ? null
    : truncateNotificationText(normalized, MAX_AGENT_COMPLETION_PREVIEW_CHARACTERS);
}

export function formatAgentNotificationTestContent(): AgentNotificationContent {
  return {
    title: "Notifications are working",
    body: "T3 Code will alert you when an agent needs attention.",
  };
}

function truncateNotificationText(value: string, maximumCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximumCharacters) {
    return value;
  }
  return `${characters.slice(0, maximumCharacters - 1).join("")}…`;
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
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "activeRunId"
    | "activityRunStatus"
    | "id"
    | "latestRunId"
    | "latestUserMessageAt"
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
  /** The approval a live subagent below this thread is waiting on. */
  readonly pendingSubagentRequest?: SubagentRequestAwareness | null;
}

export function projectThreadAwarenessV2(
  input: ProjectThreadAwarenessV2Input,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  if (!isListedThreadLineage(thread.lineage)) return null;
  const subagentRequest = input.pendingSubagentRequest ?? null;
  const phase = resolveThreadAwarenessPhaseV2(thread, subagentRequest !== null);
  if (phase === null) {
    return null;
  }
  if (phase === "completed" && thread.latestRunStopRequested === true) return null;
  // Resolve the phase first so live or waiting work stays visible after settlement.
  if (
    thread.settledOverride === "settled" &&
    (phase === "completed" || phase === "failed") &&
    !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return null;
  }
  const detail =
    phase === "completed"
      ? "Review the completed task."
      : phase === "failed"
        ? "The agent run failed."
        : undefined;
  // Changes once per agent run so the same phase on a later run re-notifies.
  const notificationVersion =
    thread.activeRunId !== null
      ? `run:${thread.activeRunId}`
      : thread.latestRunId !== null
        ? `run:${thread.latestRunId}`
        : thread.latestUserMessageAt !== null
          ? `prompt:${DateTime.formatIso(thread.latestUserMessageAt)}`
          : "legacy";
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    notificationVersion,
    // A child's request leaves the parent's own timestamp alone. Alerts are
    // keyed by phase and time, so a second wait needs the child's time.
    updatedAt: DateTime.formatIso(
      subagentRequest === null
        ? thread.updatedAt
        : DateTime.max(thread.updatedAt, subagentRequest.updatedAt),
    ),
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhaseV2(
  thread: ProjectThreadAwarenessV2Input["thread"],
  childAwaitsApproval: boolean,
): AgentAwarenessPhase | null {
  if (thread.pendingRuntimeRequest?.kind === "user_input") return "waiting_for_input";
  if (
    thread.pendingRuntimeRequest !== null &&
    thread.pendingRuntimeRequest.kind !== "auth_refresh"
  ) {
    return "waiting_for_approval";
  }
  // The parent can finish its own turn while a delegated child keeps working,
  // so a child's request outranks the parent's run status.
  if (childAwaitsApproval) return "waiting_for_approval";
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
  }
}
