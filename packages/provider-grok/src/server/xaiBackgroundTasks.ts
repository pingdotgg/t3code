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

/** Map Grok's discriminated tool results, including notifications after the turn ends. */
export function buildGrokBackgroundTaskEvents(input: {
  readonly tasks: Map<string, GrokBackgroundTaskRecord>;
  readonly toolCallId: string;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  readonly toolCallStatus: string | undefined;
  readonly turnId?: TurnId | undefined;
}): TaskEvent[] {
  const { tasks, toolCallId, toolCallStatus, turnId } = input;
  const output = record(input.rawOutput);
  const events: TaskEvent[] = [];
  if (
    toolCallStatus !== "completed" &&
    toolCallStatus !== "failed" &&
    output.type !== "BackgroundTaskStarted"
  ) {
    return events;
  }
  const attribution = (task: GrokBackgroundTaskRecord) =>
    task.turnId !== undefined && task.turnId === turnId ? { turnId } : {};
  const start = (
    id: string,
    taskType: "monitor" | "shell",
    description: string,
    toolUseId?: string,
  ) => {
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
    events.push({ type: "task.started", payload: task.payload, ...attribution(task) });
    return task;
  };
  const complete = (
    task: GrokBackgroundTaskRecord,
    status: "completed" | "failed" | "stopped",
    summary?: string,
  ) => {
    tasks.delete(task.payload.taskId);
    events.push({
      type: "task.completed",
      payload: { ...task.payload, status, ...(summary ? { summary } : {}) },
      ...attribution(task),
    });
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
      if (!id) continue;
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
      const summary = text(result.output)
        ?.split("\n")
        .find((line) => line.trim())
        ?.trim();
      if (status === "running") {
        events.push({
          type: "task.progress",
          payload: { ...task.payload, ...(summary ? { summary } : {}) },
          ...attribution(task),
        });
      } else {
        complete(task, status, summary);
      }
    }
  }
  return events;
}
