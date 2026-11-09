import {
  isListedThreadLineage,
  isSideChatThread,
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
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "activityRunStatus"
    | "id"
    | "lineage"
    | "latestRunStopRequested"
    | "modelSelection"
    | "pendingBackgroundTasks"
    | "pendingRuntimeRequest"
    | "settledOverride"
    | "sideChat"
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
  if (!isListedThreadLineage(thread.lineage) || isSideChatThread(thread)) return null;
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
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
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
