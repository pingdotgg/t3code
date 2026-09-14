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

type GrokTaskType = "monitor" | "shell" | "subagent";

export interface GrokBackgroundTaskRecord {
  readonly payload: {
    readonly taskId: RuntimeTaskId;
    readonly taskType: GrokTaskType;
    readonly description: string;
    readonly title: string;
    readonly toolUseId?: string;
    readonly role?: string;
    readonly timelineBypass?: boolean;
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

const SUBAGENT_COMMAND = /^\[subagent:([^\]]+)\]\s*(.*)$/i;

export function parseGrokSubagentCommand(
  command: string,
): { readonly role: string; readonly title: string } | undefined {
  const match = SUBAGENT_COMMAND.exec(command);
  if (!match) {
    return undefined;
  }
  const role = match[1]?.trim();
  if (!role) {
    return undefined;
  }
  const title = match[2]?.trim() || role;
  return { role, title };
}

export function parseGrokSubagentStartedText(value: string):
  | {
      readonly id: string;
      readonly role: string | undefined;
      readonly description: string | undefined;
    }
  | undefined {
  if (!/subagent started/i.test(value)) {
    return undefined;
  }
  const id = /(?:^|\n)subagent_id:\s*(\S+)/i.exec(value)?.[1]?.trim();
  if (!id) {
    return undefined;
  }
  return {
    id,
    role: /(?:^|\n)type:\s*(\S+)/i.exec(value)?.[1]?.trim(),
    description: /(?:^|\n)description:\s*(.+)/i.exec(value)?.[1]?.trim(),
  };
}

function parseCompactCount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const compact = /^([0-9]+(?:\.[0-9]+)?)\s*[kK]$/.exec(value.trim());
  if (compact) {
    return Math.round(Number(compact[1]) * 1000);
  }
  const exact = Number(value.replace(/,/g, ""));
  return Number.isFinite(exact) && exact >= 0 ? Math.round(exact) : undefined;
}

export function parseGrokSubagentProgress(output: string | undefined): {
  readonly summary?: string;
  readonly lastToolName?: string;
  readonly totalTokens?: number;
  readonly toolUses?: number;
} {
  if (!output) {
    return {};
  }
  const progressLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith("progress:"));
  const summary = progressLine
    ? progressLine.replace(/^progress:\s*/i, "").trim() || undefined
    : undefined;
  const toolUsesMatch = /([0-9][0-9,]*)\s+tool calls/i.exec(output);
  const tokenMatch =
    /([0-9]+(?:\.[0-9]+)?[kK]|[0-9][0-9,]*)\s*(?:\/\s*[0-9]+(?:\.[0-9]+)?[kK])?\s*tokens/i.exec(
      output,
    );
  const toolsLine = /tools used:\s*(.+)/i.exec(output)?.[1];
  const lastToolName = toolsLine
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .at(-1);
  return {
    ...(summary ? { summary } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(parseCompactCount(tokenMatch?.[1]) !== undefined
      ? { totalTokens: parseCompactCount(tokenMatch?.[1]) }
      : {}),
    ...(toolUsesMatch ? { toolUses: Number(toolUsesMatch[1]!.replace(/,/g, "")) } : {}),
  };
}

function subagentPayloadExtras(input: {
  readonly role?: string | undefined;
  readonly timelineBypass?: boolean | undefined;
}): { readonly role?: string; readonly timelineBypass?: boolean } {
  return {
    ...(input.role ? { role: input.role } : {}),
    ...(input.timelineBypass ? { timelineBypass: true } : {}),
  };
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
    taskType: GrokTaskType,
    description: string,
    toolUseId?: string,
    extras?: { readonly role?: string; readonly timelineBypass?: boolean },
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
        ...subagentPayloadExtras(extras ?? {}),
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
  } else if (output.type === "Text" && toolCallStatus === "completed") {
    const started = parseGrokSubagentStartedText(text(output.text) ?? "");
    if (started) {
      start(
        started.id,
        "subagent",
        started.description ?? text(record(input.rawInput).description) ?? started.id,
        toolCallId,
        { role: started.role, timelineBypass: true },
      );
    }
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
      if (!command || !status) continue;
      const subagent = parseGrokSubagentCommand(command);
      const task = subagent
        ? start(id, "subagent", subagent.title, undefined, {
            role: subagent.role,
            timelineBypass: true,
          })
        : start(id, /^\[monitor[:\]]/.test(command) ? "monitor" : "shell", command);
      const progress =
        task.payload.taskType === "subagent" ? parseGrokSubagentProgress(text(result.output)) : {};
      const summary =
        progress.summary ??
        text(result.output)
          ?.split("\n")
          .find((line) => line.trim())
          ?.trim();
      const durationMs =
        typeof result.duration_secs === "number" && Number.isFinite(result.duration_secs)
          ? Math.max(0, Math.round(result.duration_secs * 1000))
          : undefined;
      const typedUsage =
        progress.totalTokens !== undefined
          ? {
              totalTokens: progress.totalTokens,
              ...(progress.toolUses !== undefined ? { toolUses: progress.toolUses } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            }
          : undefined;
      if (status === "running") {
        events.push({
          type: "task.progress",
          payload: {
            ...task.payload,
            ...(summary ? { summary } : {}),
            ...(progress.lastToolName ? { lastToolName: progress.lastToolName } : {}),
            ...(typedUsage ? { typedUsage } : {}),
          },
          ...attribution(task),
        });
      } else {
        complete(task, status, summary);
      }
    }
  }
  return events;
}
