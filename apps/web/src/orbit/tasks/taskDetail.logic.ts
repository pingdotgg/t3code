import type {
  OrbitConversationRef,
  OrbitTasksClient,
  OrbitTasksResult,
  OrbitSubtask,
  OrbitTaskAgent,
  OrbitTaskDetail,
  OrbitTaskMetrics,
  OrbitTaskStatus,
} from "@t3tools/client-runtime/orbit-gateway";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { ProviderDriverKind } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";

/** The Input colour of thread rows (SidebarThreadRow), so a waiting agent reads the same. */
export const INPUT_TONE = "text-indigo-600 dark:text-indigo-300";

export type StatusTone = "success" | "info" | "warning" | "destructive" | "muted";

export const TASK_STATUS_TEXT: Record<OrbitTaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  reserved: "Starting",
  running: "In progress",
  reviewing: "In review",
  settling: "Settling",
  waiting_for_review: "Waiting for review",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function subtaskStatusText(subtask: OrbitSubtask, task: OrbitTaskDetail): string {
  const implementer =
    task.implementerMode === "shared" ? sharedImplementer(task) : currentImplementer(task, subtask);
  if (
    subtask.attention?.kind === "question" ||
    implementer?.needsInput ||
    implementer?.state === "asking_for_input"
  )
    return "Needs input";
  if (task.status === "waiting_for_review" && subtask.status === "reviewing")
    return "Waiting for review";
  switch (subtask.status) {
    case "todo":
      return "Not started";
    case "reserved":
      return "Starting";
    case "running":
      return "In progress";
    case "reviewing":
      return "In review";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "unknown":
      return "Unknown state";
  }
}

const started = (subtask: OrbitSubtask) =>
  subtask.status !== "todo" && subtask.status !== "reserved";

/** Green done, blue in progress, amber waiting on a person, red failure. */
function subtaskTone(
  task: OrbitTaskDetail,
  subtask: OrbitSubtask,
  implementer: OrbitTaskAgent | null,
): StatusTone {
  if (task.status === "waiting_for_review" && subtask.status === "reviewing") return "warning";
  if (
    subtask.attention?.kind === "question" ||
    implementer?.needsInput ||
    implementer?.state === "asking_for_input"
  )
    return "warning";
  switch (subtask.status) {
    case "completed":
      return "success";
    case "running":
    case "reviewing":
      return "info";
    case "failed":
      return "destructive";
    default:
      return "muted";
  }
}

/** Orbit names providers by CLI; Conn's icons are keyed by driver. */
export function orbitAgentDriverKind(provider: string | null): ProviderDriverKind | null {
  if (provider === null || provider.length === 0) return null;
  return ProviderDriverKind.make(provider === "claude" ? "claudeAgent" : provider);
}

/** The implementer that works on every subtask when Orbit runs a task with one shared agent. */
export function sharedImplementer(task: OrbitTaskDetail): OrbitTaskAgent | null {
  if (task.implementerMode !== "shared") return null;
  return task.agents.find((agent) => agent.role === "implementer" && agent.current) ?? null;
}

function currentImplementer(task: OrbitTaskDetail, subtask: OrbitSubtask): OrbitTaskAgent | null {
  const byId =
    subtask.currentImplementerAgentId === null
      ? undefined
      : task.agents.find((agent) => agent.id === subtask.currentImplementerAgentId);
  return (
    byId ??
    task.agents.findLast(
      (agent) =>
        agent.role === "implementer" && agent.current && agent.subtaskIds.includes(subtask.id),
    ) ??
    null
  );
}

/**
 * What leads a subtask row. Per subtask, a started subtask shows its implementer with the subtask's
 * state as the dot. Shared, only the subtask the agent is on shows it. Unstarted keeps a ring.
 */
export type SubtaskLead =
  | { readonly kind: "agent"; readonly agent: OrbitTaskAgent; readonly tone: StatusTone }
  | { readonly kind: "state"; readonly tone: StatusTone }
  | { readonly kind: "done" }
  | { readonly kind: "not-started" };

export function subtaskLead(task: OrbitTaskDetail, subtask: OrbitSubtask): SubtaskLead {
  if (!started(subtask)) return { kind: "not-started" };
  const shared = sharedImplementer(task);
  if (task.implementerMode === "shared") {
    if (subtask.status === "completed") return { kind: "done" };
    const active = subtask.status === "running" || subtask.status === "reviewing";
    return shared && active
      ? { kind: "agent", agent: shared, tone: subtaskTone(task, subtask, shared) }
      : { kind: "state", tone: subtaskTone(task, subtask, null) };
  }
  const implementer = currentImplementer(task, subtask);
  const tone = subtaskTone(task, subtask, implementer);
  return implementer ? { kind: "agent", agent: implementer, tone } : { kind: "state", tone };
}

export interface AgentRowModel {
  readonly agent: OrbitTaskAgent;
  readonly label: string;
  /** Only an agent with a Conn conversation opens; the rest are plain rows. */
  readonly conversation: OrbitConversationRef | null;
}

export interface AgentsModel {
  readonly current: ReadonlyArray<AgentRowModel>;
  readonly earlier: ReadonlyArray<AgentRowModel>;
}

const roleText = (agent: OrbitTaskAgent) =>
  agent.role === "implementer" ? "Implementer" : agent.role === "reviewer" ? "Reviewer" : "Agent";

function rowFor(agent: OrbitTaskAgent, label: string): AgentRowModel {
  return {
    agent,
    label: agent.attempt > 1 ? `${label} · attempt ${agent.attempt}` : label,
    conversation: agent.conversation,
  };
}

/**
 * The Agents tab for the task (`subtaskId` null) or one subtask: current agents, then earlier
 * attempts. A shared implementer appears once, as "Implementer · all subtasks".
 */
export function agentsFor(task: OrbitTaskDetail, subtaskId: number | null): AgentsModel {
  const shared = sharedImplementer(task);
  const titles = new Map(task.subtasks.map((subtask) => [subtask.id, subtask.title]));
  const label = (agent: OrbitTaskAgent) => {
    if (agent === shared) return "Implementer · all subtasks";
    const role = roleText(agent);
    if (subtaskId !== null) return role;
    if (agent.subtaskIds.length === 0) return `${role} · whole task`;
    const title = agent.subtaskIds.length === 1 ? titles.get(agent.subtaskIds[0]!) : undefined;
    return title ? `${role} · ${title}` : role;
  };
  const relevant = task.agents.filter(
    (agent) =>
      agent === shared ||
      subtaskId === null ||
      agent.subtaskIds.length === 0 ||
      agent.subtaskIds.includes(subtaskId),
  );
  // Implementers before reviewers, each in Orbit's oldest-first order.
  const ordered = [
    ...relevant.filter((agent) => agent.role === "implementer"),
    ...relevant.filter((agent) => agent.role !== "implementer"),
  ];
  return {
    current: ordered.filter((agent) => agent.current).map((agent) => rowFor(agent, label(agent))),
    earlier: ordered.filter((agent) => !agent.current).map((agent) => rowFor(agent, label(agent))),
  };
}

export function agentStateText(agent: OrbitTaskAgent): string {
  if (agent.needsInput) return "Needs input";
  switch (agent.state) {
    case "working":
      return "Working";
    case "asking_for_input":
      return "Needs input";
    case "idle":
      return "Idle";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "unknown":
      return "Unknown state";
    case null:
      return "Not observed yet";
  }
}

export function agentStateTone(agent: OrbitTaskAgent): StatusTone {
  if (agent.needsInput || agent.state === "asking_for_input") return "warning";
  switch (agent.state) {
    case "working":
      return "info";
    case "done":
      return "success";
    case "failed":
      return "destructive";
    default:
      return "muted";
  }
}

const durationText = (ms: number) => formatWorkingDurationLabel(ms);
const tokensText = (tokens: number) => `${formatTokens(tokens)} tokens`;

/** The quiet line under a subtask: only what Orbit reported. */
export function subtaskUsageText(metrics: OrbitTaskMetrics): string | null {
  const parts = [
    metrics.durationMs === null ? null : durationText(metrics.durationMs),
    metrics.tokens === null ? null : tokensText(metrics.tokens),
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The task's usage row. Tokens come from Orbit as one total, each thread counted once; never sum
 * agents here. Lines are a branch snapshot against the default branch, not a sum of subtasks.
 */
export function taskUsage(metrics: OrbitTaskMetrics): {
  readonly text: string;
  readonly lines: { readonly added: number; readonly deleted: number } | null;
  readonly description: string;
} {
  // A dash stands for an unreported value; with neither reported, one dash.
  const text =
    metrics.durationMs === null && metrics.tokens === null
      ? "–"
      : [
          metrics.durationMs === null ? "–" : durationText(metrics.durationMs),
          metrics.tokens === null ? "–" : tokensText(metrics.tokens),
        ].join(" · ");
  const lines =
    metrics.linesAdded === null || metrics.linesDeleted === null
      ? null
      : { added: metrics.linesAdded, deleted: metrics.linesDeleted };
  const description = [
    metrics.durationMs === null
      ? "Duration not reported."
      : `${durationText(metrics.durationMs)} across all attempts.`,
    metrics.tokens === null
      ? "Tokens not reported."
      : `${tokensText(metrics.tokens)} across all agents.`,
    lines === null
      ? "Branch diff not reported yet."
      : `Branch diff against the default branch at the last report: ${lines.added.toLocaleString()} added, ${lines.deleted.toLocaleString()} removed.`,
  ].join(" ");
  return { text, lines, description };
}

export function agentRowInteraction(row: AgentRowModel): "button" | "text" {
  return row.conversation === null ? "text" : "button";
}

// Subscribe before reading so an invalidation during the first request cannot be lost.
export function observeOrbitTask(
  client: OrbitTasksClient,
  taskId: number,
  onResult: (result: OrbitTasksResult<OrbitTaskDetail>) => void,
): () => void {
  let request = 0;
  let disposed = false;
  let hasTask = false;
  const read = async () => {
    const current = ++request;
    const result = await client.getTask(taskId);
    if (disposed || current !== request) return;
    if (
      result.status === "error" &&
      hasTask &&
      (result.reason === "unreachable" || result.reason === "invalid-response")
    )
      return;
    hasTask = result.status === "ok";
    onResult(result);
  };
  const unsubscribe = client.onInvalidate((target) => {
    if (target.kind === "list" || target.taskId === taskId) return read();
  });
  void read();
  return () => {
    disposed = true;
    unsubscribe();
  };
}
