function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function sessionUpdateFromRawPayload(rawPayload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(rawPayload)) {
    return undefined;
  }
  const update = rawPayload.update;
  return isRecord(update) ? update : undefined;
}

export interface XAiToolMeta {
  readonly name: string;
  readonly kind: string;
}

/** Read Grok's `x.ai/tool` stamp from a session/update notification payload. */
export function xaiToolMeta(rawPayload: unknown): XAiToolMeta | undefined {
  const update = sessionUpdateFromRawPayload(rawPayload);
  if (!update) {
    return undefined;
  }
  const meta = update._meta;
  if (!isRecord(meta)) {
    return undefined;
  }
  const tool = meta["x.ai/tool"];
  if (!isRecord(tool)) {
    return undefined;
  }
  const name = trimmed(typeof tool.name === "string" ? tool.name : undefined);
  const kind = trimmed(typeof tool.kind === "string" ? tool.kind : undefined);
  if (!name || !kind) {
    return undefined;
  }
  return { name, kind };
}

/** Store `x.ai/tool` from a tool_call / tool_call_update so later completed updates can reuse it. */
export function rememberXAiToolMeta(
  cache: Map<string, XAiToolMeta>,
  toolCallId: string,
  rawPayload: unknown,
): void {
  const meta = xaiToolMeta(rawPayload);
  if (meta) {
    cache.set(toolCallId, meta);
  }
}

function looksLikeKill(title: string | undefined, command: string | undefined): boolean {
  const haystack = `${title ?? ""} ${command ?? ""}`.toLowerCase();
  return haystack.includes("kill");
}

/**
 * Infer a background-tool stamp from completed rawInput/rawOutput when `_meta` was dropped.
 * Kill is gated: `task_ids`/`task_id` alone are not distinctive (polls use the same fields).
 */
function looksLikeSpawnSubagentInput(rawInput: unknown, title: string | undefined): boolean {
  if (trimmed(title) === "spawn_subagent") {
    return true;
  }
  if (!isRecord(rawInput)) {
    return false;
  }
  return typeof rawInput.subagent_type === "string" || rawInput.variant === "Task";
}

export function inferXAiToolMetaFromCompleted(input: {
  readonly cache: ReadonlyMap<string, XAiToolMeta>;
  readonly toolCallId: string;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  readonly title?: string | undefined;
  readonly command?: string | undefined;
}): XAiToolMeta | undefined {
  if (looksLikeSpawnSubagentInput(input.rawInput, input.title)) {
    return { name: "spawn_subagent", kind: "task" };
  }
  if (parseMonitorStart(input.rawInput, input.rawOutput)) {
    return { name: "monitor", kind: "task" };
  }
  if (parseTaskOutputResults(input.rawOutput).length > 0) {
    return { name: "get_command_or_subagent_output", kind: "background_task_action" };
  }
  if (parseKillTaskIds(input.rawInput).length === 0) {
    return undefined;
  }
  const cachedName = input.cache.get(input.toolCallId)?.name;
  if (cachedName === "kill_command_or_subagent" || looksLikeKill(input.title, input.command)) {
    return { name: "kill_command_or_subagent", kind: "kill_task_action" };
  }
  return undefined;
}

/** Resolve the completed-tool stamp: live `_meta`, then cache, then distinctive rawOutput/rawInput. */
export function resolveCompletedXAiToolMeta(input: {
  readonly cache: ReadonlyMap<string, XAiToolMeta>;
  readonly toolCallId: string;
  readonly rawPayload: unknown;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  readonly title?: string | undefined;
  readonly command?: string | undefined;
}): XAiToolMeta | undefined {
  return (
    xaiToolMeta(input.rawPayload) ??
    input.cache.get(input.toolCallId) ??
    inferXAiToolMetaFromCompleted(input)
  );
}

export interface SpawnSubagentStart {
  readonly subagentId: string;
  readonly subagentType: string;
  readonly description: string;
}

function spawnSubagentTextFromOutput(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === "string") {
    return rawOutput;
  }
  if (!isRecord(rawOutput)) {
    return undefined;
  }
  if (typeof rawOutput.text === "string") {
    return rawOutput.text;
  }
  return undefined;
}

/** Parse spawn_subagent completion text into subagent identity fields. */
export function parseSpawnSubagentStart(rawOutput: unknown): SpawnSubagentStart | undefined {
  const text = spawnSubagentTextFromOutput(rawOutput);
  if (!text) {
    return undefined;
  }
  const lines = text.split("\n");
  let subagentId: string | undefined;
  let subagentType: string | undefined;
  let description: string | undefined;
  for (const line of lines) {
    const match = /^(\w+):\s*(.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    switch (key) {
      case "subagent_id":
        subagentId = trimmed(value);
        break;
      case "type":
        subagentType = trimmed(value);
        break;
      case "description":
        description = trimmed(value);
        break;
      default:
        break;
    }
  }
  if (!subagentId || !subagentType || !description) {
    return undefined;
  }
  return { subagentId, subagentType, description };
}

export interface MonitorStart {
  readonly taskId: string;
  readonly description: string;
  readonly timeoutMs: number;
}

/** Parse monitor tool completion into a background monitor task identity. */
export function parseMonitorStart(rawInput: unknown, rawOutput: unknown): MonitorStart | undefined {
  if (!isRecord(rawOutput) || rawOutput.type !== "Monitor") {
    return undefined;
  }
  const taskId = trimmed(typeof rawOutput.taskId === "string" ? rawOutput.taskId : undefined);
  if (!taskId) {
    return undefined;
  }
  const timeoutMs =
    typeof rawOutput.timeoutMs === "number" && Number.isFinite(rawOutput.timeoutMs)
      ? rawOutput.timeoutMs
      : 0;
  const description =
    trimmed(
      isRecord(rawInput) && typeof rawInput.description === "string"
        ? rawInput.description
        : undefined,
    ) ?? "Monitor";
  return { taskId, description, timeoutMs };
}

export type TaskOutputLifecycle = "running" | "completed" | "failed" | "stopped";

export interface TaskOutputResult {
  readonly taskId: string;
  readonly command: string;
  readonly lifecycle: TaskOutputLifecycle;
  readonly output: string;
  readonly summary: string | undefined;
}

function normalizeTaskOutputLifecycle(
  status: unknown,
  exitCode: unknown,
): TaskOutputLifecycle | undefined {
  const normalizedStatus = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (normalizedStatus === "running" || normalizedStatus === "pending") {
    return "running";
  }
  if (
    normalizedStatus === "completed" ||
    normalizedStatus === "success" ||
    normalizedStatus === "succeeded"
  ) {
    return "completed";
  }
  if (normalizedStatus === "failed" || normalizedStatus === "error") {
    return "failed";
  }
  if (
    normalizedStatus === "stopped" ||
    normalizedStatus === "killed" ||
    normalizedStatus === "cancelled"
  ) {
    return "stopped";
  }
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
    return exitCode === 0 ? "completed" : "failed";
  }
  return undefined;
}

function firstLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .find((entry) => entry.trim().length > 0)
    ?.trim();
  return line && line.length > 0 ? line : undefined;
}

function parseTaskOutputEntry(entry: unknown): TaskOutputResult | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const taskId = trimmed(typeof entry.task_id === "string" ? entry.task_id : undefined);
  const command = trimmed(typeof entry.command === "string" ? entry.command : undefined);
  const lifecycle = normalizeTaskOutputLifecycle(entry.status, entry.exit_code);
  if (!taskId || !command || !lifecycle) {
    return undefined;
  }
  const output = typeof entry.output === "string" ? entry.output : "";
  return {
    taskId,
    command,
    lifecycle,
    output,
    summary: firstLine(output),
  };
}

/** Parse get_command_or_subagent_output completion into per-task poll rows. */
export function parseTaskOutputResults(rawOutput: unknown): ReadonlyArray<TaskOutputResult> {
  if (!isRecord(rawOutput) || rawOutput.type !== "TaskOutput") {
    return [];
  }
  const multi = rawOutput.MultiResult;
  if (isRecord(multi) && Array.isArray(multi.results)) {
    return multi.results.flatMap((entry) => {
      const parsed = parseTaskOutputEntry(entry);
      return parsed ? [parsed] : [];
    });
  }
  const single = rawOutput.Result;
  const parsed = parseTaskOutputEntry(single);
  return parsed ? [parsed] : [];
}

const MAX_TASK_DESCRIPTION_CHARS = 200;

function truncatedFirstLine(text: string): string {
  const line = firstLine(text) ?? text.trim();
  if (line.length <= MAX_TASK_DESCRIPTION_CHARS) {
    return line;
  }
  return line.slice(0, MAX_TASK_DESCRIPTION_CHARS);
}

export interface BackgroundTaskStarted {
  readonly taskId: string;
  readonly command: string;
  readonly summary: string | undefined;
}

/** Parse Grok auto-backgrounded shell `rawOutput.type === "BackgroundTaskStarted"`. */
export function parseBackgroundTaskStarted(rawOutput: unknown): BackgroundTaskStarted | undefined {
  if (!isRecord(rawOutput) || rawOutput.type !== "BackgroundTaskStarted") {
    return undefined;
  }
  const taskId =
    trimmed(typeof rawOutput.task_id === "string" ? rawOutput.task_id : undefined) ??
    trimmed(typeof rawOutput.taskId === "string" ? rawOutput.taskId : undefined);
  const command = trimmed(typeof rawOutput.command === "string" ? rawOutput.command : undefined);
  if (!taskId || !command) {
    return undefined;
  }
  const summary = trimmed(typeof rawOutput.summary === "string" ? rawOutput.summary : undefined);
  return { taskId, command, summary };
}

/** Parse kill_command_or_subagent rawInput into task ids to stop. */
export function parseKillTaskIds(rawInput: unknown): ReadonlyArray<string> {
  if (!isRecord(rawInput)) {
    return [];
  }
  const fromList = rawInput.task_ids;
  if (Array.isArray(fromList)) {
    return fromList.flatMap((entry) => {
      const id = trimmed(typeof entry === "string" ? entry : undefined);
      return id ? [id] : [];
    });
  }
  const single = trimmed(typeof rawInput.task_id === "string" ? rawInput.task_id : undefined);
  return single ? [single] : [];
}

export interface GrokBackgroundTaskRecord {
  readonly taskType: string;
  readonly description: string;
  readonly role?: string;
  readonly toolUseId?: string;
}

export interface GrokBackgroundTaskEventBase {
  readonly taskId: string;
  readonly description: string;
  readonly title: string;
  readonly taskType: string;
  readonly role?: string;
  readonly toolUseId?: string;
}

export type GrokBackgroundTaskRuntimeEvent =
  | { readonly type: "task.started"; readonly payload: GrokBackgroundTaskEventBase }
  | {
      readonly type: "task.progress";
      readonly payload: GrokBackgroundTaskEventBase & {
        readonly summary?: string;
      };
    }
  | {
      readonly type: "task.completed";
      readonly payload: GrokBackgroundTaskEventBase & {
        readonly status: "completed" | "failed" | "stopped";
        readonly summary?: string;
      };
    };

function linkageFor(
  tasks: Map<string, GrokBackgroundTaskRecord>,
  taskId: string,
  fallbackDescription?: string,
): GrokBackgroundTaskEventBase {
  const known = tasks.get(taskId);
  const description = known?.description ?? fallbackDescription ?? taskId;
  return {
    taskId,
    description,
    title: description,
    taskType: known?.taskType ?? "shell",
    ...(known?.role ? { role: known.role } : {}),
    ...(known?.toolUseId ? { toolUseId: known.toolUseId } : {}),
  };
}

function inferTaskTypeFromCommand(command: string): string {
  if (command.startsWith("[subagent:")) {
    return "subagent";
  }
  if (command.startsWith("[monitor:")) {
    return "monitor";
  }
  return "shell";
}

function evictCompletedTask(
  tasks: Map<string, GrokBackgroundTaskRecord>,
  taskId: string,
  fallbackDescription: string | undefined,
  status: "completed" | "failed" | "stopped",
  summary: string | undefined,
): GrokBackgroundTaskRuntimeEvent {
  const linkage = linkageFor(tasks, taskId, fallbackDescription);
  tasks.delete(taskId);
  return {
    type: "task.completed",
    payload: {
      ...linkage,
      status,
      ...(summary ? { summary } : {}),
    },
  };
}

function inferRoleFromCommand(command: string): string | undefined {
  const match = /^\[subagent:([^\]]+)\]/.exec(command);
  return match?.[1] ? trimmed(match[1]) : undefined;
}

/**
 * Synthesize task.* runtime events from a Grok background-tool call.
 * Mutates `tasks` so later poll/kill rows carry linkage fields.
 * Subagent spawn is owned by #8412; this mapper covers monitors and shells.
 */
export function buildGrokBackgroundTaskEvents(input: {
  readonly tasks: Map<string, GrokBackgroundTaskRecord>;
  readonly toolMeta?: XAiToolMeta | undefined;
  readonly toolCallId: string;
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  /** ACP tool-call status. A failed kill call must not retire the task. */
  readonly toolCallStatus?: "pending" | "inProgress" | "completed" | "failed" | undefined;
}): ReadonlyArray<GrokBackgroundTaskRuntimeEvent> {
  const { tasks, toolMeta, toolCallId, rawInput, rawOutput, toolCallStatus } = input;

  const backgroundStarted = parseBackgroundTaskStarted(rawOutput);
  if (backgroundStarted) {
    if (tasks.has(backgroundStarted.taskId)) {
      return [];
    }
    const description = truncatedFirstLine(backgroundStarted.command);
    tasks.set(backgroundStarted.taskId, {
      taskType: "shell",
      description,
      toolUseId: toolCallId,
    });
    return [
      {
        type: "task.started",
        payload: {
          taskId: backgroundStarted.taskId,
          description,
          title: description,
          taskType: "shell",
          toolUseId: toolCallId,
        },
      },
    ];
  }

  switch (toolMeta?.name) {
    case "monitor": {
      const start = parseMonitorStart(rawInput, rawOutput);
      if (!start) {
        return [];
      }
      tasks.set(start.taskId, {
        taskType: "monitor",
        description: start.description,
        toolUseId: toolCallId,
      });
      return [
        {
          type: "task.started",
          payload: {
            taskId: start.taskId,
            description: start.description,
            title: start.description,
            taskType: "monitor",
            toolUseId: toolCallId,
          },
        },
      ];
    }
    case "get_command_or_subagent_output":
      return parseTaskOutputResults(rawOutput).flatMap((result) => {
        const inferredType = inferTaskTypeFromCommand(result.command);
        const inferredRole = inferRoleFromCommand(result.command);
        const existing = tasks.get(result.taskId);
        const events: GrokBackgroundTaskRuntimeEvent[] = [];
        if (!existing && inferredType === "subagent") {
          // Subagent identity is established by #8412, not here. An orphan
          // poll row must not invent a subagent roster entry.
          return events;
        }
        if (!existing) {
          tasks.set(result.taskId, {
            taskType: inferredType,
            description: result.command,
            ...(inferredRole ? { role: inferredRole } : {}),
          });
          events.push({
            type: "task.started",
            payload: linkageFor(tasks, result.taskId, result.command),
          });
        }
        if (result.lifecycle === "running") {
          events.push({
            type: "task.progress",
            payload: {
              ...linkageFor(tasks, result.taskId, result.command),
              ...(result.summary ? { summary: result.summary } : {}),
            },
          });
          return events;
        }
        events.push(
          evictCompletedTask(
            tasks,
            result.taskId,
            result.command,
            result.lifecycle,
            result.summary,
          ),
        );
        return events;
      });
    case "kill_command_or_subagent":
      if (toolCallStatus !== "completed") {
        return [];
      }
      return parseKillTaskIds(rawInput).map((taskId) =>
        evictCompletedTask(tasks, taskId, undefined, "stopped", undefined),
      );
    default:
      return [];
  }
}
