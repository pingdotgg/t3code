import {
  ORBIT_TASK_LANES,
  orbitTaskLane,
  type OrbitConversationRef,
  type OrbitSubtask,
  type OrbitTaskAgent,
  type OrbitTaskDetail,
  type OrbitTaskLane,
  type OrbitTaskStatus,
  type OrbitTaskSummary,
  type OrbitTasksErrorReason,
} from "@t3tools/client-runtime/orbit-gateway";
import { msg } from "gt-react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

/** The mobile list shows In progress first: it is what a phone checks. */
export const MOBILE_TASK_LANES: ReadonlyArray<OrbitTaskLane> = [
  "in-progress",
  "todo",
  "backlog",
  "done",
];

export const TASK_LANE_LABELS: Readonly<Record<OrbitTaskLane, string>> = {
  backlog: msg("Backlog", { $context: "Orbit task lane" }),
  todo: msg("To do", { $context: "Orbit task lane" }),
  "in-progress": msg("In progress", { $context: "Orbit task lane" }),
  done: msg("Done", { $context: "Orbit task lane" }),
};

export function tasksInLane(
  tasks: ReadonlyArray<OrbitTaskSummary>,
  lane: OrbitTaskLane,
): ReadonlyArray<OrbitTaskSummary> {
  return tasks.filter((task) => orbitTaskLane(task.status) === lane);
}

export function isTaskLane(value: unknown): value is OrbitTaskLane {
  return ORBIT_TASK_LANES.some((lane) => lane.id === value);
}

/** Title, `#482` or `482`, project or machine. */
export function taskMatchesQuery(task: OrbitTaskSummary, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  if (needle === "") return true;
  return [
    task.title,
    String(task.id),
    task.project.name,
    task.project.slug,
    task.workspace?.node?.name ?? "",
    task.workspace?.name ?? "",
  ].some((value) => value.toLowerCase().includes(needle));
}

export type RowTone = "sky" | "indigo" | "emerald" | "warning" | "danger" | "muted";

export const ROW_TONE_TEXT: Readonly<Record<RowTone, string>> = {
  sky: "text-adaptive-sky-600-400",
  indigo: "text-adaptive-indigo-600-300",
  emerald: "text-adaptive-emerald-700-300",
  warning: "text-warning-foreground",
  danger: "text-danger-foreground",
  muted: "text-foreground-muted",
};

export const ROW_TONE_TINT: Readonly<Record<RowTone, string>> = {
  sky: "accent-adaptive-sky-600-400",
  indigo: "accent-adaptive-indigo-600-300",
  emerald: "accent-adaptive-emerald-700-300",
  warning: "accent-warning-foreground",
  danger: "accent-danger-foreground",
  muted: "accent-foreground-muted",
};

export interface RowStatus {
  readonly icon: AppSymbolName;
  readonly tone: RowTone;
  /** Null when the icon and timer say enough, like a working thread. */
  readonly label: string | null;
  readonly timerMs: number | null;
}

const WORKING_ICON = "circle.dashed" satisfies AppSymbolName;

/**
 * A task row's right side. In progress shows only the timer, like a working thread; a question or
 * a block names itself because it needs the user. Other lanes show when the task last changed.
 */
export function taskRowStatus(task: OrbitTaskSummary, durationMs: number | null): RowStatus | null {
  if (task.attention?.kind === "question")
    return { icon: "questionmark.bubble", tone: "indigo", label: msg("Input"), timerMs: null };
  if (task.status === "failed")
    return { icon: "exclamationmark.circle", tone: "danger", label: msg("Failed"), timerMs: null };
  if (
    task.attention !== null &&
    task.attention.kind !== "observation" &&
    orbitTaskLane(task.status) === "in-progress"
  )
    return { icon: "exclamationmark.circle", tone: "danger", label: msg("Blocked"), timerMs: null };
  if (orbitTaskLane(task.status) === "in-progress")
    return { icon: WORKING_ICON, tone: "sky", label: null, timerMs: durationMs };
  return null;
}

export const TASK_STATUS_TEXT: Readonly<Record<OrbitTaskStatus, string>> = {
  backlog: msg("Backlog", { $context: "Orbit task status" }),
  todo: msg("To do", { $context: "Orbit task status" }),
  reserved: msg("Starting", { $context: "Orbit task status" }),
  running: msg("In progress", { $context: "Orbit task status" }),
  reviewing: msg("In review", { $context: "Orbit task status" }),
  settling: msg("Settling", { $context: "Orbit task status" }),
  waiting_for_review: msg("Waiting for review", { $context: "Orbit task status" }),
  completed: msg("Done", { $context: "Orbit task status" }),
  failed: msg("Failed", { $context: "Orbit task status" }),
  cancelled: msg("Cancelled", { $context: "Orbit task status" }),
};

/** The task screen's status row: the label stays in the text colour; only the icon carries tone. */
export function taskStatusRow(task: OrbitTaskSummary): {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly tone: RowTone;
} {
  if (task.attention?.kind === "question")
    return { label: msg("Needs answer"), icon: "questionmark.bubble", tone: "indigo" };
  if (
    task.attention !== null &&
    task.attention.kind !== "observation" &&
    task.status !== "completed"
  )
    return { label: msg("Blocked"), icon: "exclamationmark.circle", tone: "danger" };
  const label = TASK_STATUS_TEXT[task.status];
  switch (orbitTaskLane(task.status)) {
    case "in-progress":
      return { label, icon: WORKING_ICON, tone: "sky" };
    case "done":
      return task.status === "completed"
        ? { label, icon: "checkmark.circle", tone: "emerald" }
        : {
            label,
            icon: "exclamationmark.circle",
            tone: task.status === "failed" ? "danger" : "muted",
          };
    default:
      return { label, icon: WORKING_ICON, tone: "muted" };
  }
}

const started = (subtask: OrbitSubtask) =>
  subtask.status !== "todo" && subtask.status !== "reserved";

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

function needsInput(subtask: OrbitSubtask, implementer: OrbitTaskAgent | null) {
  return (
    subtask.attention?.kind === "question" ||
    implementer?.needsInput === true ||
    implementer?.state === "asking_for_input"
  );
}

/** Green done, blue in progress, amber waiting on a person, red failure. */
export type DotTone = "success" | "info" | "warning" | "destructive" | "muted";

function subtaskDot(
  task: OrbitTaskDetail,
  subtask: OrbitSubtask,
  implementer: OrbitTaskAgent | null,
): DotTone {
  if (task.status === "waiting_for_review" && subtask.status === "reviewing") return "warning";
  if (needsInput(subtask, implementer)) return "warning";
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

/**
 * What leads a subtask row. Per subtask, a started subtask shows its implementer with the subtask's
 * state as the dot. Shared, only the subtask the agent is on shows it. Unstarted keeps a ring.
 */
export type SubtaskLead =
  | { readonly kind: "agent"; readonly agent: OrbitTaskAgent; readonly dot: DotTone }
  | { readonly kind: "working" }
  | { readonly kind: "done" }
  | { readonly kind: "failed" }
  | { readonly kind: "waiting" }
  | { readonly kind: "not-started" };

export function subtaskLead(task: OrbitTaskDetail, subtask: OrbitSubtask): SubtaskLead {
  if (!started(subtask)) return { kind: "not-started" };
  const shared = task.implementerMode === "shared";
  const implementer = shared ? sharedImplementer(task) : currentImplementer(task, subtask);
  const active = subtask.status === "running" || subtask.status === "reviewing";
  if (implementer && (!shared || active))
    return { kind: "agent", agent: implementer, dot: subtaskDot(task, subtask, implementer) };
  if (subtask.status === "completed") return { kind: "done" };
  if (subtask.status === "failed" || subtask.status === "cancelled") return { kind: "failed" };
  if (needsInput(subtask, implementer)) return { kind: "waiting" };
  return active ? { kind: "working" } : { kind: "not-started" };
}

export function subtaskStatusText(task: OrbitTaskDetail, subtask: OrbitSubtask): string {
  const implementer =
    task.implementerMode === "shared" ? sharedImplementer(task) : currentImplementer(task, subtask);
  if (needsInput(subtask, implementer)) return msg("Needs input", { $context: "Orbit subtask" });
  if (task.status === "waiting_for_review" && subtask.status === "reviewing")
    return msg("Waiting for review", { $context: "Orbit subtask" });
  switch (subtask.status) {
    case "todo":
      return msg("Not started", { $context: "Orbit subtask" });
    case "reserved":
      return msg("Starting", { $context: "Orbit subtask" });
    case "running":
      return msg("In progress", { $context: "Orbit subtask" });
    case "reviewing":
      return msg("In review", { $context: "Orbit subtask" });
    case "completed":
      return msg("Done", { $context: "Orbit subtask" });
    case "failed":
      return msg("Failed", { $context: "Orbit subtask" });
    case "cancelled":
      return msg("Cancelled", { $context: "Orbit subtask" });
    case "unknown":
      return msg("Unknown state", { $context: "Orbit subtask" });
  }
}

/** A subtask row's right side: a timer while it runs, Input or Failed, else the run time. */
export function subtaskRowStatus(task: OrbitTaskDetail, subtask: OrbitSubtask): RowStatus | null {
  const lead = subtaskLead(task, subtask);
  const implementer = lead.kind === "agent" ? lead.agent : null;
  if (needsInput(subtask, implementer))
    return { icon: "questionmark.bubble", tone: "indigo", label: msg("Input"), timerMs: null };
  if (subtask.status === "failed")
    return { icon: "exclamationmark.circle", tone: "danger", label: msg("Failed"), timerMs: null };
  if (subtask.status === "running" || subtask.status === "reviewing")
    return { icon: WORKING_ICON, tone: "sky", label: null, timerMs: subtask.metrics.durationMs };
  return null;
}

export interface AgentRowModel {
  readonly agent: OrbitTaskAgent;
  readonly role: string;
  /** What the agent works on: a subtask title, all subtasks, or the whole task. */
  readonly scope: string | null;
  /** Only an agent with a Conn conversation opens; the rest are plain rows. */
  readonly conversation: OrbitConversationRef | null;
}

export interface AgentsModel {
  readonly current: ReadonlyArray<AgentRowModel>;
  readonly earlier: ReadonlyArray<AgentRowModel>;
}

const roleText = (agent: OrbitTaskAgent) =>
  agent.role === "implementer"
    ? msg("Implementer")
    : agent.role === "reviewer"
      ? msg("Reviewer")
      : msg("Agent", { $context: "Orbit task agent of an unknown role" });

/**
 * The Agents tab for the task (`subtaskId` null) or one subtask: current agents, then earlier
 * attempts. Implementers before reviewers, each in Orbit's oldest-first order.
 */
export function agentsFor(task: OrbitTaskDetail, subtaskId: number | null): AgentsModel {
  const shared = sharedImplementer(task);
  const titles = new Map(task.subtasks.map((subtask) => [subtask.id, subtask.title]));
  const scope = (agent: OrbitTaskAgent): string | null => {
    if (agent === shared) return msg("All subtasks");
    if (subtaskId !== null) return null;
    if (agent.subtaskIds.length === 1) return titles.get(agent.subtaskIds[0]!) ?? null;
    return agent.role === "reviewer" ? msg("Whole task") : null;
  };
  const relevant = task.agents.filter(
    (agent) =>
      agent === shared ||
      subtaskId === null ||
      agent.subtaskIds.length === 0 ||
      agent.subtaskIds.includes(subtaskId),
  );
  const ordered = [
    ...relevant.filter((agent) => agent.role === "implementer"),
    ...relevant.filter((agent) => agent.role !== "implementer"),
  ];
  const row = (agent: OrbitTaskAgent): AgentRowModel => ({
    agent,
    role: roleText(agent),
    scope: scope(agent),
    conversation: agent.conversation,
  });
  return {
    current: ordered.filter((agent) => agent.current).map(row),
    earlier: ordered.filter((agent) => !agent.current).map(row),
  };
}

/** An agent row's right side. Orbit reports no agent run time, so only working agents tick. */
export function agentRowStatus(agent: OrbitTaskAgent, nowMs: number): RowStatus {
  if (agent.conversation === null && agent.state !== "done" && agent.current)
    return { icon: "bolt.horizontal.circle", tone: "danger", label: msg("Offline"), timerMs: null };
  if (agent.needsInput || agent.state === "asking_for_input")
    return { icon: "questionmark.bubble", tone: "indigo", label: msg("Input"), timerMs: null };
  switch (agent.state) {
    case "working": {
      const startedAt = Date.parse(agent.createdAt);
      return {
        icon: WORKING_ICON,
        tone: "sky",
        label: null,
        timerMs: Number.isNaN(startedAt) ? null : Math.max(0, nowMs - startedAt),
      };
    }
    case "failed":
      return {
        icon: "exclamationmark.circle",
        tone: "danger",
        label: msg("Failed"),
        timerMs: null,
      };
    case "done":
      return { icon: "checkmark.circle", tone: "muted", label: msg("Done"), timerMs: null };
    case "idle":
      return { icon: "pause", tone: "muted", label: msg("Idle"), timerMs: null };
    default:
      return { icon: "circle", tone: "muted", label: msg("Not observed"), timerMs: null };
  }
}

/** The run dot on an agent's model icon. */
export function agentDot(agent: OrbitTaskAgent): DotTone {
  if (agent.needsInput || agent.state === "asking_for_input") return "warning";
  switch (agent.state) {
    case "working":
      return "info";
    case "failed":
      return "destructive";
    case "done":
      return "success";
    default:
      return "muted";
  }
}

/** Orbit names providers by CLI; Conn's icons are keyed by driver. */
export function orbitAgentProvider(provider: string | null): string | null {
  if (provider === null || provider.length === 0) return null;
  return provider === "claude" ? "claudeAgent" : provider;
}

export function tasksErrorText(reason: OrbitTasksErrorReason): {
  readonly title: string;
  readonly detail: string;
} {
  switch (reason) {
    case "not-a-node":
      return {
        title: msg("This device is not an Orbit Node"),
        detail: msg("Orbit reads tasks only for devices on its network."),
      };
    case "access-required":
      return {
        title: msg("No access to Orbit"),
        detail: msg("This device has no access to the Node that serves tasks."),
      };
    case "extension-disabled":
      return {
        title: msg("Tasks are turned off in Orbit"),
        detail: msg("Turn on the Tasks extension in Orbit to see tasks here."),
      };
    case "not-found":
      return { title: msg("Task not found"), detail: msg("Orbit has no task with this number.") };
    case "unreachable":
    case "invalid-response":
      return {
        title: msg("Tasks are unavailable"),
        detail: msg("The Orbit Gateway did not answer. Pull to try again."),
      };
  }
}
