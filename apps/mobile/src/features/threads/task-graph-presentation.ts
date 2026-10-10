import type {
  TaskGraph,
  TaskGraphNode,
  TaskGraphNodeStatus,
  TaskGraphStatus,
} from "@t3tools/contracts";
import { isActiveTaskGraphNodeStatus } from "@t3tools/shared/taskGraph";

import type { SubagentRowTone } from "./threadAgentsPresentation";

const BLOCKING_STATUSES: ReadonlySet<TaskGraphNodeStatus> = new Set([
  "failed",
  "cancelled",
  "skipped",
]);

export const isOpenTaskGraph = (graph: Pick<TaskGraph, "status">): boolean =>
  graph.status === "draft" || graph.status === "running";

export function taskGraphNodeTone(status: TaskGraphNodeStatus): SubagentRowTone {
  if (isActiveTaskGraphNodeStatus(status)) return "working";
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

export function taskGraphTone(status: TaskGraphStatus): SubagentRowTone {
  if (status === "running") return "working";
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

export function taskGraphNodeStatusLabel(status: TaskGraphNodeStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "waiting":
      return "Waiting";
    case "running":
      return "Running";
    case "delivering":
      return "Opening PR";
    case "succeeded":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
  }
}

const localDayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** An upcoming instant: "3:40 PM" today, "tomorrow at 3:40 PM", else "Oct 13, 3:40 PM". */
function formatTaskGraphWaitTime(iso: string, now: number): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const days = Math.round((localDayStart(at) - localDayStart(new Date(now))) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow at ${time}`;
  const date = at.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" as const } : {}),
  });
  return `${date}, ${time}`;
}

/** Why a waiting node waits and what happens next, as on web. Null when it is not waiting. */
export function taskGraphNodeWaitDetail(
  node: Pick<TaskGraphNode, "status" | "waitUntil" | "waitReason" | "threadId">,
  now: number,
): string | null {
  if (node.status !== "waiting") return null;
  const at = node.waitUntil === null ? null : formatTaskGraphWaitTime(node.waitUntil, now);
  if (node.waitReason === "usage_limit") {
    const next =
      node.threadId === null ? "starts after the reset" : "continues on its thread after the reset";
    return `Usage limit reached — ${next}${at === null ? "" : `, ${at}`}`;
  }
  return at === null ? "Waiting to start" : `Starts ${at}`;
}

export function taskGraphStatusLabel(status: TaskGraphStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "running":
      return "Running";
    case "succeeded":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** One-line status for a graph, such as "Running · 2 of 5 done". */
export function taskGraphSummaryLabel(graph: Pick<TaskGraph, "status" | "nodes">): string {
  const total = graph.nodes.length;
  const tasks = `${total} ${total === 1 ? "task" : "tasks"}`;
  if (graph.status === "draft" || graph.status === "succeeded") {
    return `${taskGraphStatusLabel(graph.status)} · ${tasks}`;
  }
  if (graph.status === "running") {
    const done = graph.nodes.filter((node) => node.status === "succeeded").length;
    const waiting = graph.nodes.filter((node) => node.status === "waiting").length;
    return `Running · ${done} of ${total} done${waiting > 0 ? ` · ${waiting} waiting` : ""}`;
  }
  const failed = graph.nodes.filter((node) => node.status === "failed").length;
  return failed > 0
    ? `${taskGraphStatusLabel(graph.status)} · ${failed} failed`
    : `${taskGraphStatusLabel(graph.status)} · ${tasks}`;
}

/** Open graphs first (running before draft), then the most recently changed. */
export function sortTaskGraphs(graphs: ReadonlyArray<TaskGraph>): ReadonlyArray<TaskGraph> {
  const rank = (graph: TaskGraph) =>
    graph.status === "running" ? 0 : graph.status === "draft" ? 1 : 2;
  return [...graphs].sort(
    (left, right) => rank(left) - rank(right) || right.updatedAt.localeCompare(left.updatedAt),
  );
}

export interface TaskGraphSegment {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly tone: SubagentRowTone;
}

/**
 * The thread's task graph entry point. Finished graphs keep it visible so a
 * failed node can still be retried and its pull requests reached.
 */
export function resolveTaskGraphSegment(
  graphs: ReadonlyArray<TaskGraph> | null,
): TaskGraphSegment | null {
  if (graphs === null || graphs.length === 0) return null;
  const open = graphs.filter(isOpenTaskGraph);
  if (open.length > 1) {
    return {
      label: `${open.length} graphs`,
      accessibilityLabel: `${open.length} open task graphs`,
      tone: open.some((graph) => graph.status === "running") ? "working" : "stopped",
    };
  }
  const graph = sortTaskGraphs(graphs)[0]!;
  const label =
    graph.status === "running"
      ? `Graph ${graph.nodes.filter((node) => node.status === "succeeded").length}/${graph.nodes.length}`
      : `Graph ${taskGraphStatusLabel(graph.status).toLowerCase()}`;
  return {
    label,
    accessibilityLabel: `Task graph ${graph.title}, ${taskGraphSummaryLabel(graph)}`,
    tone: taskGraphTone(graph.status),
  };
}

export interface TaskGraphActions {
  readonly run: boolean;
  readonly cancel: boolean;
}

export const taskGraphActions = (graph: Pick<TaskGraph, "status">): TaskGraphActions => ({
  run: graph.status === "draft",
  cancel: isOpenTaskGraph(graph),
});

export interface TaskGraphNodeActions {
  readonly cancelBranch: boolean;
  readonly retry: boolean;
}

/**
 * What a node offers. A cancelled graph takes no edits. Retrying a skipped
 * node whose dependency still has not succeeded would only skip it again, so
 * that retry belongs on the dependency instead.
 */
export function taskGraphNodeActions(
  graph: Pick<TaskGraph, "status" | "nodes">,
  node: Pick<TaskGraphNode, "status" | "dependsOn">,
): TaskGraphNodeActions {
  if (graph.status === "cancelled") return { cancelBranch: false, retry: false };
  const cancelBranch =
    isOpenTaskGraph(graph) &&
    (node.status === "pending" ||
      node.status === "waiting" ||
      isActiveTaskGraphNodeStatus(node.status));
  if (node.status === "failed" || node.status === "cancelled") return { cancelBranch, retry: true };
  if (node.status !== "skipped") return { cancelBranch, retry: false };
  const statusByKey = new Map(graph.nodes.map((other) => [other.key, other.status]));
  const blocked = node.dependsOn.some((key) => {
    const status = statusByKey.get(key);
    return status !== undefined && BLOCKING_STATUSES.has(status);
  });
  return { cancelBranch, retry: !blocked };
}
