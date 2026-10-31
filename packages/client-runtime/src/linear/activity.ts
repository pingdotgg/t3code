import type {
  EnvironmentId,
  LinearActivityItem,
  LinearIssue,
  LinearIssueActivity,
  PipelineRunSummary,
} from "@t3tools/contracts";

import { topLevelIssues } from "./issueList.ts";

export type LinearActivityPillKind =
  | "pipeline-failed"
  | "pipeline-running"
  | "pipeline-remote"
  | "pr-opened"
  | "chats";

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
  if (activity.items.some(isUnreadRemoteRun)) {
    return { kind: "pipeline-remote", label: "pipeline run", chatCount };
  }
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

/** Thread id -> issue identifier ("ATT-615") for every thread or pipeline-run parent thread linked to an issue. */
export function threadIdentifiersFromActivity(
  issues: ReadonlyArray<LinearIssueActivity>,
): ReadonlyMap<string, string> {
  const identifiers = new Map<string, string>();
  for (const issue of issues) {
    for (const item of issue.items) identifiers.set(item.link.threadId, issue.issueIdentifier);
  }
  return identifiers;
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

/**
 * "Jump back in" issue ids: the ones with the most recent T3 activity, capped. Sorted by id so
 * new activity that only reorders them keeps the same issues query.
 */
export function jumpBackInIssueIds(
  issues: ReadonlyArray<LinearIssueActivity>,
  limit = MAX_JUMP_BACK_IN,
): ReadonlyArray<string> {
  return [...issues]
    .sort((a, b) => Date.parse(b.latestActivityAt) - Date.parse(a.latestActivityAt))
    .slice(0, limit)
    .map((entry) => entry.issueId)
    .sort();
}

/** The fetched "Jump back in" issues, most recent T3 activity first; sub-issues of listed parents nest. */
export function orderJumpBackInIssues(
  issues: ReadonlyArray<LinearIssue>,
  activity: ReadonlyArray<LinearIssueActivity>,
): ReadonlyArray<LinearIssue> {
  const latest = new Map(
    activity.map((entry) => [entry.issueId, Date.parse(entry.latestActivityAt)]),
  );
  return [...topLevelIssues(issues)].sort(
    (a, b) => (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0),
  );
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

/** A pipeline run on another machine whose state this client has not read (yet). */
function isUnreadRemoteRun(item: LinearActivityItem): boolean {
  return (
    item.link.targetKind === "pipeline_run" &&
    item.link.environmentId != null &&
    item.pipeline === null
  );
}

/** The machine an activity item opens on: its own, else the one that serves Linear. */
export function activityItemEnvironmentId(
  item: Pick<LinearActivityItem, "link">,
  primaryEnvironmentId: EnvironmentId,
): EnvironmentId {
  return item.link.environmentId ?? primaryEnvironmentId;
}

function summarizeIssueActivity(
  issueId: string,
  items: ReadonlyArray<LinearActivityItem>,
): LinearIssueActivity | null {
  const first = items[0];
  if (first === undefined) return null;
  const sorted = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    issueId,
    issueIdentifier: first.link.issueIdentifier,
    teamId: first.link.teamId,
    items: sorted,
    latestActivityAt: sorted[0]?.updatedAt ?? first.updatedAt,
    runningCount: sorted.filter((item) => item.status === "running").length,
    threadCount: sorted.filter((item) => item.link.targetKind === "thread").length,
    pipelineRunning: sorted.some((item) => item.pipeline !== null && item.status === "running"),
    pipelineFailed: sorted.some((item) => item.pipeline !== null && item.status === "failed"),
  };
}

/**
 * One activity list from the server that serves Linear and the machines connected to the same
 * Linear workspace. A peer's own items are stamped with its environment id so they open there, and
 * an item present in several sources appears once.
 */
export function mergeLinearActivity(input: {
  readonly primary: ReadonlyArray<LinearIssueActivity>;
  readonly peers: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly issues: ReadonlyArray<LinearIssueActivity>;
  }>;
}): ReadonlyArray<LinearIssueActivity> {
  if (input.peers.length === 0) return input.primary;
  const itemsByIssue = new Map<string, Map<string, LinearActivityItem>>();
  const add = (issues: ReadonlyArray<LinearIssueActivity>, stamp: EnvironmentId | null) => {
    for (const entry of issues) {
      const items = itemsByIssue.get(entry.issueId) ?? new Map<string, LinearActivityItem>();
      itemsByIssue.set(entry.issueId, items);
      for (const item of entry.items) {
        const stamped =
          stamp === null || item.link.environmentId != null
            ? item
            : { ...item, link: { ...item.link, environmentId: stamp } };
        const key = `${stamped.link.environmentId ?? ""}:${stamped.link.targetKind}:${stamped.link.targetId}`;
        if (!items.has(key)) items.set(key, stamped);
      }
    }
  };
  add(input.primary, null);
  for (const peer of input.peers) add(peer.issues, peer.environmentId);
  return [...itemsByIssue]
    .flatMap(([issueId, items]) => summarizeIssueActivity(issueId, [...items.values()]) ?? [])
    .sort((a, b) => b.latestActivityAt.localeCompare(a.latestActivityAt));
}

/**
 * Shows the live state of runs on other machines this client is connected to. Runs missing from
 * `liveRuns` (finished, or the machine is not streaming) keep the state the server reported.
 */
export function applyRemoteRunStatus(
  issues: ReadonlyArray<LinearIssueActivity>,
  liveRuns: ReadonlyMap<string, PipelineRunSummary>,
): ReadonlyArray<LinearIssueActivity> {
  if (liveRuns.size === 0) return issues;
  let changed = false;
  const result = issues.map((entry) => {
    let entryChanged = false;
    const items = entry.items.map((item) => {
      if (!isUnreadRemoteRun(item)) return item;
      const run = liveRuns.get(`${item.link.environmentId}:${item.link.targetId}`);
      if (run === undefined) return item;
      entryChanged = true;
      const current = run.status === "running" || run.status === "paused";
      const failedIndex = run.steps.findIndex((step) => step.status === "failed");
      return {
        ...item,
        title: run.name,
        status:
          run.status === "running"
            ? "running"
            : run.pauseReason === "step_failed"
              ? "failed"
              : "paused",
        pipeline: {
          name: run.name,
          steps: run.steps.map((step) => ({ name: step.name, status: step.status })),
          currentStepName: current ? (run.steps[run.currentStepIndex]?.name ?? null) : null,
          failedStepName: failedIndex >= 0 ? (run.steps[failedIndex]?.name ?? null) : null,
        },
      } satisfies LinearActivityItem;
    });
    if (!entryChanged) return entry;
    changed = true;
    return summarizeIssueActivity(entry.issueId, items) ?? entry;
  });
  return changed ? result : issues;
}
