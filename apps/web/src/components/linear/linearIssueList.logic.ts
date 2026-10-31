import type { LinearIssue, LinearIssueActivity, LinearStateType } from "@t3tools/contracts";

import { NO_MILESTONE_ID, type LinearGroupBy } from "./linearSearch";

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
    .toSorted((a, b) => Date.parse(b.latestActivityAt) - Date.parse(a.latestActivityAt))
    .slice(0, limit)
    .map((entry) => entry.issueId);
}

/** Issues whose parent is in the same list render nested under it instead of twice. */
export function topLevelIssues(issues: ReadonlyArray<LinearIssue>): ReadonlyArray<LinearIssue> {
  const ids = new Set(issues.map((issue) => issue.id));
  return issues.filter((issue) => issue.parent === null || !ids.has(issue.parent.id));
}

const STATE_TYPE_RANK: Record<LinearStateType, number> = {
  started: 0,
  unstarted: 1,
  triage: 2,
  backlog: 3,
  completed: 4,
  canceled: 5,
};

export interface LinearIssueGroup {
  readonly key: string;
  readonly label: string;
  readonly stateType: LinearStateType | null;
  readonly issues: ReadonlyArray<LinearIssue>;
}

/** Workflow position per state id, when the team's metadata is loaded; orders within a type. */
export type LinearStatePositions = ReadonlyMap<string, number>;

export function groupLinearIssues(
  issues: ReadonlyArray<LinearIssue>,
  groupBy: LinearGroupBy,
  statePositions: LinearStatePositions = new Map(),
): ReadonlyArray<LinearIssueGroup> {
  if (groupBy === "none") {
    return issues.length === 0 ? [] : [{ key: "all", label: "Issues", stateType: null, issues }];
  }
  const groups = new Map<
    string,
    { group: LinearIssueGroup; issues: Array<LinearIssue>; order: number }
  >();
  for (const issue of issues) {
    let key: string;
    let label: string;
    let stateType: LinearStateType | null = null;
    let order: number;
    if (groupBy === "state") {
      key = issue.state.id;
      label = issue.state.name;
      stateType = issue.state.type;
      const position = statePositions.get(issue.state.id) ?? 0;
      // Later workflow steps lead among started states ("In Review" above "In Progress").
      order =
        STATE_TYPE_RANK[issue.state.type] * 1_000 +
        (issue.state.type === "started" ? -position : position);
    } else {
      key = issue.milestone?.id ?? NO_MILESTONE_ID;
      label = issue.milestone?.name ?? "No milestone";
      order = issue.milestone === null ? Number.MAX_SAFE_INTEGER : 0;
    }
    const existing = groups.get(key);
    if (existing) existing.issues.push(issue);
    else {
      const list = [issue];
      groups.set(key, {
        group: { key, label, stateType, issues: list },
        issues: list,
        order,
      });
    }
  }
  return [...groups.values()]
    .toSorted((a, b) => a.order - b.order || a.group.label.localeCompare(b.group.label))
    .map((entry) => entry.group);
}

export function formatProgressPercent(progress: number): number {
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
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
