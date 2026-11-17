import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

/**
 * The tasks Orbit tracks, as Conn reads them (Orbit's Conn Tasks read contract v1). Orbit owns
 * tasks; Conn Server owns conversations. Wire decoding lives in `tasksWire.ts`.
 */

export type OrbitTaskStatus =
  | "backlog"
  | "todo"
  | "reserved"
  | "running"
  | "reviewing"
  | "settling"
  | "waiting_for_review"
  | "completed"
  | "failed"
  | "cancelled";

export type OrbitSubtaskStatus =
  | "todo"
  | "reserved"
  | "running"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

/** "question": an agent waits for an answer. The others come from Orbit's assistance fields. */
export interface OrbitTaskAttention {
  readonly kind: "question" | "failure" | "direction" | "observation" | "removal_failure";
  readonly question: string | null;
  readonly reason: string | null;
}

/** Null is unknown, never zero. */
export interface OrbitTaskMetrics {
  /** Wall clock across every attempt and wait, up to now while it runs. */
  readonly durationMs: number | null;
  /** Null while no agent thread reports usage, which is every T3 task copy today. */
  readonly tokens: number | null;
  /** Task: the branch's diff against the default branch at the last report, not a sum. Subtask: always null. */
  readonly linesAdded: number | null;
  readonly linesDeleted: number | null;
}

export interface OrbitTaskWorkspace {
  readonly instanceId: number;
  readonly name: string;
  /** The Instance status; `removing` and `removed` mean the copy is disposed. */
  readonly status: string;
  readonly powerState: "running" | "stopped" | null;
  readonly node: { readonly id: number; readonly name: string } | null;
  readonly branch: string | null;
  /** Null when the copy has no registered server, or the caller has no access to its Node. */
  readonly connEnvironmentId: EnvironmentId | null;
}

export interface OrbitTaskSummary {
  readonly id: number;
  readonly title: string;
  readonly status: OrbitTaskStatus;
  readonly attention: OrbitTaskAttention | null;
  readonly project: {
    readonly id: number;
    readonly slug: string;
    readonly name: string;
    readonly code: string | null;
  };
  /** Null before the task starts, or after its copy was removed. */
  readonly workspace: OrbitTaskWorkspace | null;
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly state: "open" | "merged" | "closed" | null;
  } | null;
  readonly subtaskCounts: {
    readonly total: number;
    readonly todo: number;
    readonly running: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string | null;
}

export interface OrbitSubtask {
  readonly id: number;
  readonly position: number;
  readonly title: string;
  readonly brief: string;
  readonly deliverables: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly description: string;
  }>;
  /** "unknown": a status this contract version does not name. */
  readonly status: OrbitSubtaskStatus | "unknown";
  readonly attention: OrbitTaskAttention | null;
  /** Orbit's agent record id, matching an `OrbitTaskAgent.id`. */
  readonly currentImplementerAgentId: number | null;
  readonly metrics: OrbitTaskMetrics;
}

/** A Conn conversation, by its canonical server and thread. */
export interface OrbitConversationRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface OrbitTaskAgent {
  /** Orbit's agent-thread record id. Never a Conn thread id. */
  readonly id: number;
  /** "unknown": a role this contract version does not name. */
  readonly role: "implementer" | "reviewer" | "unknown";
  readonly subtaskIds: ReadonlyArray<number>;
  /** False for earlier attempts. */
  readonly current: boolean;
  /** Counts per role and subtask, from 1. */
  readonly attempt: number;
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Null before Orbit's first observation; "unknown" for a state this contract does not name. */
  readonly state: "idle" | "working" | "asking_for_input" | "done" | "failed" | "unknown" | null;
  readonly needsInput: boolean;
  readonly createdAt: string;
  readonly observedAt: string | null;
  /** The only link to a Conn thread. Null when the workspace is gone or not reachable: no navigation. */
  readonly conversation: OrbitConversationRef | null;
}

export interface OrbitTaskDetail extends OrbitTaskSummary {
  readonly brief: string;
  /** Always "per_subtask" today; "shared" is reserved for a future Orbit mode. */
  readonly implementerMode: "per_subtask" | "shared";
  readonly metrics: OrbitTaskMetrics;
  /** In position order. */
  readonly subtasks: ReadonlyArray<OrbitSubtask>;
  /** Implementers and reviewers, oldest first, current and earlier attempts. */
  readonly agents: ReadonlyArray<OrbitTaskAgent>;
}

export type OrbitTasksErrorReason =
  /** 403 `peer.identity_unknown`: this device is not an active Orbit Node. */
  | "not-a-node"
  /** 403 `node_access.required`: no access edge, or it was revoked. */
  | "access-required"
  /** 409 `extension.disabled`: the Conn or Tasks extension is off. */
  | "extension-disabled"
  /** 404 `http.404`: no such task, or a subtask id. */
  | "not-found"
  /** No transport, or the Gateway did not answer. */
  | "unreachable"
  /** The Gateway answered something this contract does not describe. */
  | "invalid-response";

export type OrbitTasksResult<A> =
  | { readonly status: "ok"; readonly value: A }
  | { readonly status: "error"; readonly reason: OrbitTasksErrorReason; readonly message: string };

export interface OrbitTasksListQuery {
  /** Orbit Project id. Without it the list is every task this Node may read. */
  readonly project?: number;
  readonly instance?: number;
  readonly status?: OrbitTaskStatus;
  readonly limit?: number;
  readonly cursor?: number;
}

export interface OrbitTasksPage {
  readonly tasks: ReadonlyArray<OrbitTaskSummary>;
  /** Rows left out because they did not match the contract, such as an unknown status. */
  readonly skipped: number;
  readonly nextCursor: number | null;
}

/** Realtime notices only invalidate; the read that follows is authoritative. */
export type OrbitTasksInvalidation =
  | { readonly kind: "list" }
  | { readonly kind: "task"; readonly taskId: number };

export interface OrbitTasksClient {
  readonly listTasks: (query?: OrbitTasksListQuery) => Promise<OrbitTasksResult<OrbitTasksPage>>;
  readonly getTask: (taskId: number) => Promise<OrbitTasksResult<OrbitTaskDetail>>;
  /** Tells subscribers to read again: a Reverb notice, a reconnect, or a poll tick. */
  readonly invalidate: (target: OrbitTasksInvalidation) => Promise<void>;
  readonly onInvalidate: (listener: (target: OrbitTasksInvalidation) => unknown) => () => void;
}

export type OrbitTaskLane = "backlog" | "todo" | "in-progress" | "done";

export const ORBIT_TASK_LANES: ReadonlyArray<{
  readonly id: OrbitTaskLane;
  readonly label: string;
}> = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "To do" },
  { id: "in-progress", label: "In progress" },
  { id: "done", label: "Done" },
];

/** Board lanes are a view over Orbit's statuses, not a lifecycle of their own. */
export function orbitTaskLane(status: OrbitTaskStatus): OrbitTaskLane {
  switch (status) {
    case "backlog":
      return "backlog";
    case "todo":
    case "reserved":
      return "todo";
    case "running":
    case "reviewing":
    case "settling":
    case "waiting_for_review":
      return "in-progress";
    case "completed":
    case "failed":
    case "cancelled":
      return "done";
  }
}

export type OrbitTaskLabelTone = "info" | "warning" | "destructive" | "muted";

/** The finer state a card names inside its lane, or null when the lane says enough. */
export function orbitTaskLabel(
  task: Pick<OrbitTaskSummary, "status" | "attention">,
): { readonly label: string; readonly tone: OrbitTaskLabelTone } | null {
  if (task.attention?.kind === "question") return { label: "Needs answer", tone: "warning" };
  if (task.status === "failed") return { label: "Failed", tone: "destructive" };
  if (task.status === "cancelled") return { label: "Cancelled", tone: "muted" };
  if (task.attention !== null && task.attention.kind !== "observation") {
    return { label: "Blocked", tone: "destructive" };
  }
  switch (task.status) {
    case "reviewing":
    case "waiting_for_review":
      return { label: "In review", tone: "info" };
    case "running":
    case "settling":
      return { label: "Working", tone: "info" };
    default:
      return null;
  }
}

/** Where the task's workspace stands, from the 200-response cases of the contract. */
export type OrbitTaskEnvironment =
  | { readonly kind: "not-started" }
  | { readonly kind: "disposed" }
  | { readonly kind: "stopped" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "ready"; readonly environmentId: EnvironmentId };

export function orbitTaskEnvironment(
  task: Pick<OrbitTaskSummary, "status" | "workspace">,
): OrbitTaskEnvironment {
  const { workspace } = task;
  if (workspace === null) {
    return orbitTaskLane(task.status) === "backlog" || orbitTaskLane(task.status) === "todo"
      ? { kind: "not-started" }
      : { kind: "disposed" };
  }
  if (workspace.status === "removing" || workspace.status === "removed")
    return { kind: "disposed" };
  if (workspace.powerState === "stopped") return { kind: "stopped" };
  if (workspace.connEnvironmentId === null) return { kind: "unreachable" };
  return { kind: "ready", environmentId: workspace.connEnvironmentId };
}
