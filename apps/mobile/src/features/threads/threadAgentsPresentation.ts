import {
  formatSubagentDisplayTitle,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";

const PROMPT_TITLE_LIMIT = 80;

export type SubagentRowTone = "working" | "completed" | "failed" | "stopped";

export interface SubagentRowPresentation {
  readonly title: string;
  /** Live agents lead with progress; settled ones lead with what came out. */
  readonly detail: string | null;
  readonly statusLabel: string;
  readonly tone: SubagentRowTone;
  readonly live: boolean;
  /** Provider-native tasks have no thread of their own to open. */
  readonly canOpenThread: boolean;
  /** The linked environment the task runs in, when it runs in one. */
  readonly runsOn: string | null;
}

/**
 * Where an agent's thread opens: here, or in the linked environment that runs
 * it. Null when there is no thread, or this app is not connected to that
 * environment.
 */
export function subagentThreadTarget(
  subagent: Pick<OrchestrationV2Subagent, "childThreadId" | "remoteChild">,
  environmentId: EnvironmentId,
  isKnownEnvironment: (environmentId: EnvironmentId) => boolean,
): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null {
  if (subagent.childThreadId !== null) {
    return { environmentId, threadId: subagent.childThreadId };
  }
  const remote = subagent.remoteChild;
  return remote !== undefined && isKnownEnvironment(remote.environmentId)
    ? { environmentId: remote.environmentId, threadId: remote.threadId }
    : null;
}

function rowTitle(subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">): string {
  const title = subagent.title?.trim();
  if (title) return formatSubagentDisplayTitle(title);
  const prompt = subagent.prompt.trim();
  if (prompt.length === 0) return "Subagent";
  return prompt.length > PROMPT_TITLE_LIMIT
    ? `${prompt.slice(0, PROMPT_TITLE_LIMIT - 3)}...`
    : prompt;
}

function rowTone(status: OrchestrationV2Subagent["status"]): SubagentRowTone {
  if (isActiveSubagentStatus(status)) return "working";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

function rowStatusLabel(status: OrchestrationV2Subagent["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return "Working";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

export function resolveSubagentRowPresentation(
  subagent: Pick<
    OrchestrationV2Subagent,
    "title" | "prompt" | "status" | "progress" | "result" | "childThreadId" | "remoteChild"
  >,
  canOpenRemote = false,
): SubagentRowPresentation {
  const live = isActiveSubagentStatus(subagent.status);
  return {
    title: rowTitle(subagent),
    detail: subagentDetailPreview(subagent),
    statusLabel: rowStatusLabel(subagent.status),
    tone: rowTone(subagent.status),
    live,
    canOpenThread:
      subagent.childThreadId !== null || (subagent.remoteChild !== undefined && canOpenRemote),
    runsOn: subagent.remoteChild?.label ?? null,
  };
}
