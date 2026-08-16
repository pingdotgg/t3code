import type {
  DesktopNotificationEvent,
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

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

export interface ProjectThreadAwarenessInput {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<OrchestrationProjectShell, "title">;
  readonly thread: Pick<
    OrchestrationThreadShell,
    | "id"
    | "title"
    | "modelSelection"
    | "session"
    | "latestTurn"
    | "latestUserMessageAt"
    | "updatedAt"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
  >;
}

export function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export function projectThreadAwareness(
  input: ProjectThreadAwarenessInput,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  const phase = resolveThreadAwarenessPhase(thread);
  if (!phase) {
    return null;
  }

  const detail = detailForPhase(phase, thread);
  const notificationVersion = thread.session?.activeTurnId
    ? `turn:${thread.session.activeTurnId}`
    : thread.latestTurn !== null
      ? `turn:${thread.latestTurn.turnId}`
      : thread.latestUserMessageAt !== null
        ? `prompt:${thread.latestUserMessageAt}`
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
    updatedAt: thread.updatedAt,
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhase(
  thread: ProjectThreadAwarenessInput["thread"],
): AgentAwarenessPhase | null {
  if (thread.hasPendingApprovals) {
    return "waiting_for_approval";
  }
  if (thread.hasPendingUserInput) {
    return "waiting_for_input";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failed";
  }
  if (thread.session?.status === "starting") {
    return "starting";
  }
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return "running";
  }
  if (thread.latestTurn?.state === "completed") {
    return "completed";
  }
  // A turn that finished can still read as "interrupted" here: session
  // teardown settles still-running turns by session status, and that write
  // can race the turn.completed one. completedAt survives the race — a turn
  // that has a completion timestamp finished, whatever the state column says.
  // Without this, quick finish-then-teardown threads resolve to null
  // persistently and get tombstoned instead of published as completed.
  if (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null) {
    return "completed";
  }
  // Threads whose turns never produce a checkpoint (no code changes) have no
  // materialized latestTurn in the shell at all, and the session-set
  // projection clears latest_turn_id the moment the session settles. The
  // session status is then the only surviving completion signal: a live
  // session at "ready"/"idle" with nothing pending and nothing running means
  // the agent finished and is waiting for the next prompt — Done.
  if (thread.session?.status === "ready" || thread.session?.status === "idle") {
    return "completed";
  }
  return null;
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

function detailForPhase(
  phase: AgentAwarenessPhase,
  thread: ProjectThreadAwarenessInput["thread"],
): string | undefined {
  if (phase === "failed") {
    return thread.session?.lastError ?? undefined;
  }
  if (phase === "completed") {
    return "Review the completed task.";
  }
  if (phase === "running" && thread.session?.providerName) {
    return `${thread.session.providerName} is active.`;
  }
  return undefined;
}
