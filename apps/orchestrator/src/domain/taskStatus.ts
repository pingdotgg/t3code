export const TASK_STATUSES = [
  "ready",
  "working",
  "needs_input",
  "ready_for_review",
  "done",
  "blocked",
  "failed",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type LinearWorkflowStateType =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export interface TaskStatusTransitionResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

const TASK_STATUS_TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map([
  ["ready", new Set(["working", "needs_input", "blocked", "canceled"])],
  ["working", new Set(["needs_input", "blocked", "failed", "ready_for_review", "canceled"])],
  ["needs_input", new Set(["working", "ready_for_review", "canceled"])],
  ["blocked", new Set(["working", "ready_for_review", "canceled"])],
  ["failed", new Set(["working", "canceled"])],
  ["ready_for_review", new Set(["done", "canceled"])],
  ["done", new Set()],
  ["canceled", new Set()],
]);

const LINEAR_STATUS_NAME_MAP: readonly [RegExp, TaskStatus][] = [
  [/\b(cancel(?:ed|led)|canceled|cancelled)\b/i, "canceled"],
  [/\b(done|merged|complete|completed|closed)\b/i, "done"],
  [/\b(review|in review|ready for review|pr)\b/i, "ready_for_review"],
  [/\b(blocked|blocked by)\b/i, "blocked"],
  [/\b(needs input|need input|question|waiting|waiting for|needs info)\b/i, "needs_input"],
  [/\b(working|in progress|started|doing)\b/i, "working"],
  [/\b(backlog|todo|to do|ready|triage|unstarted)\b/i, "ready"],
];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "done" || status === "canceled";
}

export function isValidTaskStatusTransition(input: {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
}): TaskStatusTransitionResult {
  const { from, to } = input;

  if (from === to) {
    return { allowed: true };
  }

  if (isTerminalTaskStatus(from)) {
    return {
      allowed: false,
      reason: `Cannot transition from terminal Task status ${from} to ${to}.`,
    };
  }

  if (TASK_STATUS_TRANSITIONS.get(from)?.has(to) === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Cannot transition Task status from ${from} to ${to}.`,
  };
}

export function mapLinearStateToTaskStatus(input: {
  readonly name?: string | null;
  readonly type?: LinearWorkflowStateType | string | null;
}): TaskStatus | undefined {
  const type = input.type?.trim().toLowerCase();

  switch (type) {
    case "backlog":
    case "unstarted":
      return "ready";
    case "started":
      return "working";
    case "completed":
      return "done";
    case "canceled":
      return "canceled";
  }

  const name = input.name?.trim();
  if (!name) {
    return undefined;
  }

  return LINEAR_STATUS_NAME_MAP.find(([pattern]) => pattern.test(name))?.[1];
}
