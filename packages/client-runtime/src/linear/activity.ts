import type { LinearIssue, LinearIssueActivity } from "@t3tools/contracts";

export type LinearActivityPillKind = "pipeline-failed" | "pipeline-running" | "pr-opened" | "chats";

export interface LinearActivityPill {
  readonly kind: LinearActivityPillKind;
  readonly label: string;
  /** Chats beside a pipeline or PR pill ("pipeline failed | 1 chat"). */
  readonly chatCount: number;
}

function hasOpenPullRequest(issue: Pick<LinearIssue, "linkedPullRequests">): boolean {
  return issue.linkedPullRequests.some(
    (pullRequest) => pullRequest.state?.toLowerCase() === "open",
  );
}

/**
 * One pill per issue: pipeline failed > pipeline running > PR opened (T3 links and an open
 * linked PR) > "N chat(s)". Issues without T3 links get none.
 */
export function pickActivityPill(
  issue: Pick<LinearIssue, "linkedPullRequests">,
  activity: LinearIssueActivity | undefined,
): LinearActivityPill | null {
  if (activity === undefined || activity.items.length === 0) return null;
  const chatCount = activity.threadCount;
  if (activity.pipelineFailed)
    return { kind: "pipeline-failed", label: "pipeline failed", chatCount };
  if (activity.pipelineRunning)
    return { kind: "pipeline-running", label: "pipeline running", chatCount };
  if (hasOpenPullRequest(issue)) return { kind: "pr-opened", label: "PR opened", chatCount };
  if (chatCount > 0) {
    return {
      kind: "chats",
      label: `${chatCount} ${chatCount === 1 ? "chat" : "chats"}`,
      chatCount: 0,
    };
  }
  return null;
}

export function indexActivityByIssueId(
  issues: ReadonlyArray<LinearIssueActivity>,
): ReadonlyMap<string, LinearIssueActivity> {
  return new Map(issues.map((entry) => [entry.issueId, entry]));
}

/** Running T3 items per team, for the workspace-level team cards. */
export function runningCountByTeam(
  issues: ReadonlyArray<LinearIssueActivity>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of issues) {
    if (entry.runningCount === 0) continue;
    counts.set(entry.teamId, (counts.get(entry.teamId) ?? 0) + entry.runningCount);
  }
  return counts;
}

const MAX_JUMP_BACK_IN = 20;

/** "Jump back in": the issues with the most recent T3 activity first, capped. */
export function recentActivityIssueIds(
  issues: ReadonlyArray<LinearIssueActivity>,
  limit = MAX_JUMP_BACK_IN,
): ReadonlyArray<string> {
  return [...issues]
    .sort((a, b) => Date.parse(b.latestActivityAt) - Date.parse(a.latestActivityAt))
    .slice(0, limit)
    .map((entry) => entry.issueId);
}

export type LinearStepTone = "ok" | "running" | "failed" | "idle";

/** Mini step bar segment colour for a pipeline step status. */
export function stepTone(status: string): LinearStepTone {
  switch (status) {
    case "completed":
      return "ok";
    case "running":
      return "running";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

const ACTIVITY_STATUS_LABEL: Record<string, string> = {
  running: "Running",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
};

export function activityStatusLabel(status: string): string {
  return ACTIVITY_STATUS_LABEL[status] ?? status;
}
