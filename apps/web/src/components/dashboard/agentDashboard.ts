import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type { ThreadShell } from "../../types";

export type AgentColumn = "Needs You" | "Working" | "Done" | "Idle";

/** A projection of the live shell, never a second execution status. */
export function classifyDashboardThread(
  thread: Pick<
    ThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "interactionMode"
    | "runtime"
    | "latestRun"
    | "pendingBackgroundTasks"
  >,
  connected = true,
): { column: AgentColumn; label: string } {
  if (!connected) return { column: "Needs You", label: "Disconnected · status unknown" };
  if (thread.hasPendingApprovals) return { column: "Needs You", label: "Approval requested" };
  if (thread.hasPendingUserInput) return { column: "Needs You", label: "Question unanswered" };
  const status = thread.runtime?.status ?? thread.latestRun?.status;
  if (status && ["queued", "preparing", "starting", "running", "waiting"].includes(status)) {
    return { column: "Working", label: status };
  }
  if (status === "failed") {
    return {
      column: "Needs You",
      label: thread.runtime?.lastErrorClass === "usage_limit" ? "Usage limit reached" : "Failed",
    };
  }
  if (status === "interrupted" || status === "cancelled") {
    return { column: "Needs You", label: status === "interrupted" ? "Interrupted" : "Cancelled" };
  }
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks)) {
    return { column: "Working", label: "Delegated work" };
  }
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) {
    return { column: "Needs You", label: "Plan ready" };
  }
  if (thread.latestRun?.status === "completed") return { column: "Done", label: "Completed" };
  return { column: "Idle", label: status === "rolled_back" ? "Rolled back" : "Idle" };
}

export function dashboardThreadMatches(
  thread: ThreadShell,
  filters: {
    search: string;
    project: string;
    workspace: string;
    pullRequest: string;
    environment?: string;
    provider?: string;
    status?: string;
  },
  projectName: string,
): boolean {
  if (filters.environment && filters.environment !== thread.environmentId) return false;
  if (filters.provider && filters.provider !== thread.providerInstanceId) return false;
  if (
    filters.project &&
    filters.project !== JSON.stringify([thread.environmentId, thread.projectId])
  )
    return false;
  if (
    filters.workspace &&
    !`${thread.worktreePath ?? ""} ${thread.branch ?? ""}`
      .toLowerCase()
      .includes(filters.workspace.toLowerCase())
  )
    return false;
  const prs = [
    ...thread.pullRequests.map((pr) => `${pr.number} ${pr.url} ${pr.snapshot?.title ?? ""}`),
    thread.linkedPullRequest?.url ?? "",
    thread.branchPullRequest?.url ?? "",
  ]
    .join(" ")
    .toLowerCase();
  if (filters.pullRequest && !prs.includes(filters.pullRequest.toLowerCase())) return false;
  return `${thread.title} ${projectName} ${thread.providerInstanceId} ${thread.modelSelection.model}`
    .toLowerCase()
    .includes(filters.search.toLowerCase());
}

export interface DashboardEntry {
  thread: ThreadShell;
  children: DashboardEntry[];
  state: ReturnType<typeof classifyDashboardThread>;
}
export function dashboardEntries(
  threads: readonly ThreadShell[],
  connected: ReadonlySet<string>,
): DashboardEntry[] {
  const key = (thread: ThreadShell) => JSON.stringify([thread.environmentId, thread.id]);
  const indexed = new Map(threads.map((thread) => [key(thread), thread]));
  const byParent = new Map<string, ThreadShell[]>();
  const roots: ThreadShell[] = [];
  for (const thread of threads) {
    const parent =
      thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId
        ? JSON.stringify([thread.environmentId, thread.lineage.parentThreadId])
        : null;
    if (parent && parent !== key(thread) && indexed.has(parent)) {
      const siblings = byParent.get(parent) ?? [];
      siblings.push(thread);
      byParent.set(parent, siblings);
    } else roots.push(thread);
  }
  const seen = new Set<string>();
  function entry(thread: ThreadShell): DashboardEntry {
    seen.add(key(thread));
    const children = (byParent.get(key(thread)) ?? [])
      .filter((child) => !seen.has(key(child)))
      .map(entry);
    let state = classifyDashboardThread(thread, connected.has(thread.environmentId));
    if (
      state.column !== "Needs You" &&
      children.some((child) => child.state.column === "Needs You")
    )
      state = { column: "Needs You", label: "Delegated agent needs attention" };
    else if (
      (state.column === "Idle" || state.column === "Done") &&
      children.some((child) => child.state.column === "Working")
    )
      state = { column: "Working", label: "Delegated agent working" };
    return { thread, children, state };
  }
  const result = roots.map(entry);
  // A malformed lineage cycle must not make sessions disappear.
  for (const thread of threads) if (!seen.has(key(thread))) result.push(entry(thread));
  return result;
}
export function dashboardThreadTarget(thread: Pick<ThreadShell, "environmentId" | "id">) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: thread.environmentId, threadId: thread.id },
  };
}
