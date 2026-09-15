import {
  RuntimeTaskId,
  type ProviderRuntimeTaskStartedEvent,
  type ProviderRuntimeTaskProgressEvent,
  type ProviderRuntimeTaskCompletedEvent,
  type TurnId,
} from "@t3tools/contracts";

type TaskEvent =
  | Pick<ProviderRuntimeTaskStartedEvent, "type" | "payload" | "turnId">
  | Pick<ProviderRuntimeTaskProgressEvent, "type" | "payload" | "turnId">
  | Pick<ProviderRuntimeTaskCompletedEvent, "type" | "payload" | "turnId">;

export interface GrokBackgroundTaskRecord {
  readonly payload: {
    readonly taskId: RuntimeTaskId;
    readonly taskType: "monitor" | "shell";
    readonly description: string;
    readonly title: string;
    readonly toolUseId?: string;
  };
  readonly turnId: TurnId | undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function lifecycle(status: unknown, exitCode: unknown) {
  switch (text(status)?.toLowerCase()) {
    case "pending":
    case "running":
      return "running";
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "killed":
    case "cancelled":
      return "stopped";
    default:
      return typeof exitCode === "number" && Number.isFinite(exitCode)
        ? exitCode === 0
          ? "completed"
          : "failed"
        : undefined;
  }
}

function taskAttribution(task: GrokBackgroundTaskRecord, turnId?: TurnId | undefined) {
  return task.turnId !== undefined && task.turnId === turnId ? { turnId } : {};
}

/** Bounded FIFO of closed task ids; delete-then-add refreshes recency. */
export function rememberClosedTaskId(
  closed: Set<string>,
  id: string,
  cap: number | undefined = 500,
): void {
  closed.delete(id);
  closed.add(id);
  if (closed.size > cap) {
    const oldest = closed.values().next().value;
    if (oldest !== undefined) closed.delete(oldest);
  }
}

function completeTask(
  tasks: Map<string, GrokBackgroundTaskRecord>,
  task: GrokBackgroundTaskRecord,
  status: "completed" | "failed" | "stopped",
  turnId?: TurnId | undefined,
  summary?: string,
  closedTaskIds?: Set<string> | undefined,
): TaskEvent {
  tasks.delete(task.payload.taskId);
  if (closedTaskIds) rememberClosedTaskId(closedTaskIds, task.payload.taskId);
  return {
    type: "task.completed",
    payload: { ...task.payload, status, ...(summary ? { summary } : {}) },
    ...taskAttribution(task, turnId),
  };
}

/** The task id of a completed Grok task_completed notice, or undefined. */
export function grokTaskCompletedNoticeId(notification: unknown): string | undefined {
  const update = record(record(notification).update);
  if (update.sessionUpdate !== "task_completed") return undefined;

  const snapshot = record(update.task_snapshot);
  if (snapshot.completed !== true || snapshot.kind === "subagent") return undefined;

  return text(snapshot.task_id);
}

/** Remember a completion whose task T3 has not started yet (bounded, oldest evicted). */
export function rememberPendingTaskCompletion(
  pending: Map<string, unknown>,
  taskId: string,
  notification: unknown,
  cap = 100,
): void {
  pending.delete(taskId);
  pending.set(taskId, notification);
  if (pending.size > cap) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
}

/** Pure decision helper for the ext notification handler. */
export function decideGrokTaskCompletedNotice(input: {
  readonly notification: unknown;
  readonly tasks: ReadonlyMap<string, GrokBackgroundTaskRecord>;
  readonly publishedTaskIds: ReadonlySet<string>;
  readonly closedTaskIds: ReadonlySet<string>;
}): { readonly action: "ignore" } | { readonly action: "close" | "park"; readonly taskId: string } {
  const id = grokTaskCompletedNoticeId(input.notification);
  if (!id) return { action: "ignore" };
  if (input.closedTaskIds.has(id)) return { action: "ignore" };
  if (input.tasks.has(id) && input.publishedTaskIds.has(id)) {
    return { action: "close", taskId: id };
  }
  return { action: "park", taskId: id };
}

/** Close a known monitor/shell when Grok emits task_completed (ACP ext notification). */
export function buildGrokTaskCompletedEvents(input: {
  readonly tasks: Map<string, GrokBackgroundTaskRecord>;
  readonly notification: unknown;
  readonly turnId?: TurnId | undefined;
  readonly closedTaskIds?: Set<string> | undefined;
}): TaskEvent[] {
  const id = grokTaskCompletedNoticeId(input.notification);
  if (!id) return [];
  if (input.closedTaskIds?.has(id)) return [];

  const update = record(record(input.notification).update);
  const snapshot = record(update.task_snapshot);
  const task = input.tasks.get(id);
  if (!task) return [];

  let status: ReturnType<typeof lifecycle>;
  if (snapshot.explicitly_killed === true) {
    status = "stopped";
  } else {
    status = lifecycle(snapshot.status, snapshot.exit_code);
    if (status === undefined && text(snapshot.signal)) {
      status = "stopped";
    }
  }
  if (status === undefined || status === "running") {
    status = "completed";
  }

  const summary = text(snapshot.output)
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim();

  return [completeTask(input.tasks, task, status, input.turnId, summary, input.closedTaskIds)];
}

/** Map Grok's discriminated tool results, including notifications after the turn ends. */
export function buildGrokBackgroundTaskEvents(input: {
  readonly tasks: Map<string, GrokBackgroundTaskRecord>;
  readonly toolCallId: string;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  readonly toolCallStatus: string | undefined;
  readonly turnId?: TurnId | undefined;
  readonly closedTaskIds?: Set<string> | undefined;
}): TaskEvent[] {
  const { tasks, toolCallId, toolCallStatus, turnId, closedTaskIds } = input;
  const output = record(input.rawOutput);
  const events: TaskEvent[] = [];
  if (
    toolCallStatus !== "completed" &&
    toolCallStatus !== "failed" &&
    output.type !== "BackgroundTaskStarted"
  ) {
    return events;
  }
  const start = (
    id: string,
    taskType: "monitor" | "shell",
    description: string,
    toolUseId?: string,
  ) => {
    if (closedTaskIds?.has(id)) return undefined;
    const known = tasks.get(id);
    if (known) return known;
    const task: GrokBackgroundTaskRecord = {
      payload: {
        taskId: RuntimeTaskId.make(id),
        taskType,
        description,
        title: description,
        ...(toolUseId ? { toolUseId } : {}),
      },
      // Polls can rediscover older tasks without establishing their originating turn.
      turnId: toolUseId ? turnId : undefined,
    };
    tasks.set(id, task);
    events.push({ type: "task.started", payload: task.payload, ...taskAttribution(task, turnId) });
    return task;
  };
  const complete = (
    task: GrokBackgroundTaskRecord,
    status: "completed" | "failed" | "stopped",
    summary?: string,
  ) => {
    events.push(completeTask(tasks, task, status, turnId, summary, closedTaskIds));
  };

  if (output.type === "Monitor" && toolCallStatus === "completed") {
    const id = text(output.taskId);
    if (id) start(id, "monitor", text(record(input.rawInput).description) ?? "Monitor", toolCallId);
  } else if (output.type === "BackgroundTaskStarted") {
    const id = text(output.task_id) ?? text(output.taskId);
    const command = text(output.command);
    if (id && command) start(id, "shell", command.split("\n")[0]!.slice(0, 200), toolCallId);
  } else if (output.type === "TaskOutput" || output.type === "KillTask") {
    const results = record(output.MultiResult).results;
    for (const value of Array.isArray(results) ? results : [output.Result]) {
      const result = record(value);
      const id = text(result.task_id);
      if (!id || closedTaskIds?.has(id)) continue;
      if (output.type === "KillTask") {
        const task = tasks.get(id);
        if (task && toolCallStatus === "completed" && result.outcome === "killed")
          complete(task, "stopped");
        continue;
      }
      const command = text(result.command);
      const status = lifecycle(result.status, result.exit_code);
      if (!command || !status || command.startsWith("[subagent:")) continue;
      const task = start(id, /^\[monitor[:\]]/.test(command) ? "monitor" : "shell", command);
      if (!task) continue;
      const summary = text(result.output)
        ?.split("\n")
        .find((line) => line.trim())
        ?.trim();
      if (status === "running") {
        events.push({
          type: "task.progress",
          payload: { ...task.payload, ...(summary ? { summary } : {}) },
          ...taskAttribution(task, turnId),
        });
      } else {
        complete(task, status, summary);
      }
    }
  }
  return events;
}
