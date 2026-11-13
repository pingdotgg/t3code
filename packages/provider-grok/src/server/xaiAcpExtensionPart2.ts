import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import { resultFromGetOutputTool, resultTaskIdFromGetOutputTool, statusFromGetOutputTool, structuredTaskIdFromGetOutputTool } from "./xaiAcpExtensionPart3.ts";

export const xAiRateLimitedErrorCode = -32003;

export const completedXAiPromptIdLimit = 128;

export const XAiPromptCompleteNotification = Schema.Struct({
  sessionId: Schema.String,
  promptId: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  agentResult: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

export type XAiPromptCompleteNotification = typeof XAiPromptCompleteNotification.Type;

const XAiSessionUpdateNotification = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Struct({
    sessionUpdate: Schema.String,
    prompt_id: Schema.optional(Schema.String),
    promptId: Schema.optional(Schema.String),
    stop_reason: Schema.optional(Schema.String),
    stopReason: Schema.optional(Schema.String),
    agent_result: Schema.optional(Schema.NullOr(Schema.Unknown)),
    child_session_id: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    output: Schema.optional(Schema.NullOr(Schema.String)),
    error: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  _meta: Schema.optional(Schema.Unknown),
});

type XAiSessionUpdateNotification = typeof XAiSessionUpdateNotification.Type;

export const decodeXAiSessionUpdateNotification = Schema.decodeUnknownEffect(XAiSessionUpdateNotification);

export const xAiSessionNotificationMethods = [
  "x.ai/session_notification",
  "_x.ai/session_notification",
  "_x.ai/session/update",
] as const;

const XAI_TASK_COMPLETED_PROMPT_ID_PREFIX = "task-completed-";

export function xAiPromptCompleteFromSessionUpdate(
  notification: XAiSessionUpdateNotification,
): XAiPromptCompleteNotification | null {
  const update = notification.update;
  if (update.sessionUpdate !== "turn_completed") {
    return null;
  }
  const promptId = nonEmptyString(update.prompt_id) ?? nonEmptyString(update.promptId);
  // Require prompt identity to avoid matching background completions or unrelated turns.
  if (promptId === undefined || promptId.startsWith(XAI_TASK_COMPLETED_PROMPT_ID_PREFIX)) {
    return null;
  }
  const stopReason = nonEmptyString(update.stop_reason) ?? nonEmptyString(update.stopReason);
  return {
    sessionId: notification.sessionId,
    promptId,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(update.agent_result === undefined ? {} : { agentResult: update.agent_result }),
  };
}

/** Background command wakes use their own task-completed-* prompt IDs. */
export function isXAiTaskCompletedWakeNotification(
  notification: EffectAcpSchema.SessionNotification,
): boolean {
  const promptId = notification._meta?.promptId;
  return typeof promptId === "string" && promptId.startsWith(XAI_TASK_COMPLETED_PROMPT_ID_PREFIX);
}

export interface PendingXAiPromptCompletion {
  readonly sessionId: string;
  readonly promptId: string;
  readonly deferred: Deferred.Deferred<
    EffectAcpSchema.PromptResponse,
    EffectAcpErrors.AcpRequestError
  >;
}

export interface XAiAcpSubagentUpdate {
  readonly nativeTaskId: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly status: "running" | "completed" | "failed";
  readonly childSessionId: string | null;
  readonly result: string | null;
  /** Defaults to true; false also projects a normal tool item for hydration. */
  readonly suppressNormalTool?: boolean;
}

export interface XAiAcpBackgroundToolMutation {
  readonly taskId: string;
  readonly status: "running" | "completed" | "failed";
  readonly appendOutput: string;
}

export interface XAiAcpSubagentEndNotice {
  readonly childSessionId: string;
  readonly status: "completed" | "failed";
}

export const XAI_UUID_RE = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

export function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function titleKey(toolCall: AcpToolCallState): string {
  return (toolCall.title ?? "").trim().toLowerCase();
}

export function decodeByteText(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return undefined;
  if (!value.every((entry) => typeof entry === "number")) return undefined;
  try {
    return nonEmptyString(new TextDecoder().decode(Uint8Array.from(value as number[])));
  } catch {
    return undefined;
  }
}

export function xAiToolOutputText(toolCall: AcpToolCallState): string | undefined {
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  if (rawOutput !== undefined) {
    const direct =
      nonEmptyString(rawOutput.text) ??
      nonEmptyString(rawOutput.output_for_prompt) ??
      decodeByteText(rawOutput.output);
    if (direct !== undefined) return direct;
    const result = unknownRecord(rawOutput.Result) ?? unknownRecord(rawOutput.result);
    if (result !== undefined) {
      const nested =
        nonEmptyString(result.output) ??
        nonEmptyString(result.text) ??
        decodeByteText(result.output);
      if (nested !== undefined) return nested;
    }
  }
  if (typeof toolCall.data.rawOutput === "string") {
    return nonEmptyString(toolCall.data.rawOutput);
  }
  const content = toolCall.data.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((entry) => {
      const record = unknownRecord(entry);
      const nested = unknownRecord(record?.content);
      return nonEmptyString(nested?.text) ?? nonEmptyString(record?.text) ?? [];
    })
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

export function firstUuidMatch(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match?.[1];
}

export function extractXAiChildSessionId(output: string | undefined): string | null {
  if (output === undefined) return null;
  return (
    firstUuidMatch(output, new RegExp(`(?:^|\\n)\\s*Agent ID:\\s*(${XAI_UUID_RE})\\b`, "i")) ??
    firstUuidMatch(output, new RegExp(`(?:^|\\n)\\s*subagent_id:\\s*(${XAI_UUID_RE})\\b`, "i")) ??
    firstUuidMatch(output, new RegExp(`===\\s*Task\\s+(${XAI_UUID_RE})\\s*===`, "i")) ??
    null
  );
}

export function isXAiAsyncSpawnAck(output: string | undefined): boolean {
  if (output === undefined) return false;
  if (/subagent started in background/i.test(output)) return true;
  return (
    new RegExp(`subagent_id:\\s*${XAI_UUID_RE}`, "i").test(output) &&
    /get_command_or_subagent_output/i.test(output)
  );
}

export function isXAiMonitorStartAck(output: string | undefined): boolean {
  if (output === undefined) return false;
  return /monitor started\s*\(\s*task\s+/i.test(output);
}

export function isXAiSpawnOrTaskTool(
  toolCall: AcpToolCallState,
  rawInput: Record<string, unknown> | undefined,
): boolean {
  const title = titleKey(toolCall);
  if (title === "task" || title === "spawn_subagent" || title.includes("spawn subagent")) {
    return true;
  }
  const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
  if (variant === "cursortask" || variant === "task" || variant === "spawn_subagent") {
    return true;
  }
  if (nonEmptyString(rawInput?.subagent_type) !== undefined) return true;
  if (nonEmptyString(rawInput?.subagentType) !== undefined) return true;
  return false;
}

export function isXAiGetSubagentOutputTool(
  toolCall: AcpToolCallState,
  rawInput: Record<string, unknown> | undefined,
): boolean {
  const title = titleKey(toolCall);
  if (
    title === "get_command_or_subagent_output" ||
    title.includes("get_command_or_subagent_output") ||
    title === "wait_commands_or_subagents"
  ) {
    return true;
  }
  const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
  if (variant === "taskoutput" || variant === "task_output") return true;
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  const outputType = nonEmptyString(rawOutput?.type)?.toLowerCase();
  if (outputType === "taskoutput" || outputType === "task_output") return true;
  if (title.startsWith("[subagent:") && Array.isArray(rawInput?.task_ids)) return true;
  return false;
}

export function isXAiMonitorTool(toolCall: AcpToolCallState): boolean {
  const title = titleKey(toolCall);
  if (title === "monitor" || title.startsWith("monitor ")) return true;
  const rawInput = unknownRecord(toolCall.data.rawInput);
  const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
  if (variant === "monitor") return true;
  // Start ACK titles can be generic; the structured Monitor envelope remains authoritative.
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  const outputType = nonEmptyString(rawOutput?.type)?.toLowerCase();
  if (outputType === "monitor") return true;
  // Older clients send plain Text ACKs; these still identify the monitor after title rewrites.
  return isXAiMonitorStartAck(xAiToolOutputText(toolCall));
}

/**
 * BackgroundTaskStarted completes the tool call while the shell process still runs.
 * The task ends on a completion notification or completed TaskOutput for its task id.
 */
export function xAiBackgroundShellTaskId(toolCall: AcpToolCallState): string | undefined {
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  return nonEmptyString(rawOutput?.type) === "BackgroundTaskStarted"
    ? nonEmptyString(rawOutput?.task_id)
    : undefined;
}

export function extractXAiMonitorTaskId(toolCall: AcpToolCallState): string | undefined {
  const backgroundShellTaskId = xAiBackgroundShellTaskId(toolCall);
  if (backgroundShellTaskId !== undefined) return backgroundShellTaskId;
  if (!isXAiMonitorTool(toolCall)) return undefined;
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  if (rawOutput !== undefined && nonEmptyString(rawOutput.type)?.toLowerCase() === "monitor") {
    const structured = nonEmptyString(rawOutput.taskId) ?? nonEmptyString(rawOutput.task_id);
    if (structured !== undefined) return structured;
  }
  const output = xAiToolOutputText(toolCall);
  if (output !== undefined) {
    const fromAck = firstUuidMatch(
      output,
      new RegExp(`monitor started\\s*\\(\\s*task\\s+(${XAI_UUID_RE})\\b`, "i"),
    );
    if (fromAck !== undefined) return fromAck;
  }
  const rawInput = unknownRecord(toolCall.data.rawInput);
  return (
    nonEmptyString(rawInput?.task_id) ??
    nonEmptyString(rawInput?.taskId) ??
    (Array.isArray(rawInput?.task_ids) ? nonEmptyString(rawInput.task_ids[0]) : undefined)
  );
}

/** Persistent monitors must not hold root-turn deferred finalize. */
export function isXAiPersistentMonitor(toolCall: AcpToolCallState): boolean {
  if (!isXAiMonitorTool(toolCall)) return false;
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  if (rawOutput !== undefined && nonEmptyString(rawOutput.type)?.toLowerCase() === "monitor") {
    return rawOutput.persistent === true;
  }
  const rawInput = unknownRecord(toolCall.data.rawInput);
  return rawInput?.persistent === true;
}

export function extractXAiBackgroundTaskCompletion(toolCall: AcpToolCallState): ReadonlyArray<{
  readonly taskId: string;
  readonly status: "running" | "completed" | "failed";
  readonly appendOutput: string;
}> {
  const rawInput = unknownRecord(toolCall.data.rawInput);
  if (!isXAiGetSubagentOutputTool(toolCall, rawInput)) return [];
  const text = xAiToolOutputText(toolCall);
  const status = statusFromGetOutputTool(toolCall, text);
  const appendOutput = resultFromGetOutputTool(toolCall, text) ?? "";
  // Prefer the completed identity from the result/header over the request list
  // (one call can poll multiple task_ids).
  // Command task ids can be `call-<uuid>-<index>`; subagent ids stay UUID-only.
  const resultTaskId =
    structuredTaskIdFromGetOutputTool(toolCall) ?? resultTaskIdFromGetOutputTool(toolCall, text);
  if (resultTaskId !== undefined) {
    return [{ taskId: resultTaskId, status, appendOutput }];
  }
  const requestIds: string[] = [];
  const push = (value: unknown) => {
    const id = nonEmptyString(value);
    if (id !== undefined && new RegExp(`^${XAI_UUID_RE}$`, "i").test(id)) {
      requestIds.push(id);
    }
  };
  if (Array.isArray(rawInput?.task_ids)) {
    for (const entry of rawInput.task_ids) push(entry);
  }
  push(rawInput?.task_id);
  push(rawInput?.taskId);
  const unique = [...new Set(requestIds)];
  return unique.map((taskId) => ({ taskId, status, appendOutput }));
}

/**
 * A finished kill_command_or_subagent call is the genuine end signal for every
 * task id it names, even without a separate `x.ai/task_completed` notification.
 * A failed kill is not proof the target stopped, so leave the existing
 * task state unchanged until a genuine terminal signal arrives.
 */
export function extractXAiKilledBackgroundTasks(toolCall: AcpToolCallState): ReadonlyArray<{
  readonly taskId: string;
  readonly status: "running" | "completed" | "failed";
  readonly appendOutput: string;
}> {
  const title = titleKey(toolCall);
  const rawInput = unknownRecord(toolCall.data.rawInput);
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
  const legacy = title.includes("kill_command_or_subagent") || variant === "kill";
  if (!legacy && variant !== "killtask" && rawOutput?.type !== "KillTask") return [];
  if (toolCall.status !== "completed") return [];
  // Grok nests the outcome under Result; only a missing, killed or already_exited one ends the task.
  const outcome = rawOutput?.outcome ?? unknownRecord(rawOutput?.Result)?.outcome;
  if (!legacy && outcome !== undefined && outcome !== "killed" && outcome !== "already_exited")
    return [];
  const taskIds: string[] = [];
  const push = (value: unknown) => {
    const id = nonEmptyString(value);
    if (id !== undefined) taskIds.push(id);
  };
  if (Array.isArray(rawInput?.task_ids)) {
    for (const entry of rawInput.task_ids) push(entry);
  }
  push(rawInput?.task_id);
  push(rawInput?.taskId);
  return [...new Set(taskIds)].map((taskId) => ({
    taskId,
    status: "completed" as const,
    appendOutput: "",
  }));
}

const XAiTaskLifecycleNotification = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Struct({
    sessionUpdate: Schema.String,
    task_id: Schema.optional(Schema.String),
    tool_call_id: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
    description: Schema.optional(Schema.NullOr(Schema.String)),
    monitor_description: Schema.optional(Schema.NullOr(Schema.String)),
    task_snapshot: Schema.optional(
      Schema.Struct({
        task_id: Schema.optional(Schema.String),
        output: Schema.optional(Schema.String),
        exit_code: Schema.optional(Schema.NullOr(Schema.Number)),
        command: Schema.optional(Schema.String),
        display_command: Schema.optional(Schema.NullOr(Schema.String)),
        description: Schema.optional(Schema.NullOr(Schema.String)),
        kind: Schema.optional(Schema.String),
      }),
    ),
  }),
  _meta: Schema.optional(Schema.Unknown),
});

type XAiTaskLifecycleNotification = typeof XAiTaskLifecycleNotification.Type;

export interface XAiBackgroundTaskLifecycleMutation {
  readonly sessionId: string;
  readonly taskId: string;
  readonly status: "running" | "completed" | "failed";
  readonly output?: string;
  readonly report?:
    | { readonly kind: "command"; readonly label?: string; readonly exitCode?: number }
    | { readonly kind: "monitor"; readonly label?: string };
}

function xAiBackgroundTaskReport(
  update: XAiTaskLifecycleNotification["update"],
): XAiBackgroundTaskLifecycleMutation["report"] {
  const snapshot = update.task_snapshot;
  const monitorDescription = nonEmptyString(update.monitor_description ?? undefined);
  const displayCommand = nonEmptyString(snapshot?.display_command ?? undefined);
  const isMonitor =
    snapshot?.kind === "monitor" ||
    monitorDescription !== undefined ||
    displayCommand?.startsWith("[monitor]") === true;
  const isCommand =
    snapshot?.kind === "bash" || snapshot?.command !== undefined || update.command !== undefined;
  if (!isMonitor && !isCommand) return undefined;
  const label =
    monitorDescription ??
    nonEmptyString(snapshot?.description ?? undefined) ??
    nonEmptyString(update.description ?? undefined) ??
    displayCommand?.replace(/^\[monitor\]\s*/, "") ??
    nonEmptyString(snapshot?.command) ??
    nonEmptyString(update.command);
  const named = label === undefined ? {} : { label };
  if (isMonitor) return { kind: "monitor", ...named };
  const exitCode = snapshot?.exit_code;
  return { kind: "command", ...named, ...(typeof exitCode === "number" ? { exitCode } : {}) };
}

export function xAiBackgroundTaskLifecycleMutation(
  notification: XAiTaskLifecycleNotification,
  status: "running" | "completed",
): XAiBackgroundTaskLifecycleMutation | null {
  const update = notification.update;
  const taskId =
    nonEmptyString(update.task_snapshot?.task_id) ??
    nonEmptyString(update.task_id) ??
    nonEmptyString(update.tool_call_id);
  if (taskId === undefined) return null;
  const exitCode = update.task_snapshot?.exit_code;
  const output = update.task_snapshot?.output;
  const report = xAiBackgroundTaskReport(update);
  return {
    sessionId: notification.sessionId,
    taskId,
    status:
      status === "completed" && typeof exitCode === "number" && exitCode !== 0 ? "failed" : status,
    ...(output === undefined ? {} : { output }),
    ...(report === undefined ? {} : { report }),
  };
}

/** Track both x.ai/task_* and legacy _x.ai/task_*; background tasks can survive cancellation. */
export const registerXAiBackgroundTaskTracking = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "handleExtNotification">,
  apply: (mutation: XAiBackgroundTaskLifecycleMutation) => Effect.Effect<void>,
): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  Effect.forEach(
    [
      ["x.ai/task_backgrounded", "running"],
      ["_x.ai/task_backgrounded", "running"],
      ["x.ai/task_completed", "completed"],
      ["_x.ai/task_completed", "completed"],
    ] as const,
    ([method, status]) =>
      runtime.handleExtNotification(method, XAiTaskLifecycleNotification, (notification) => {
        const mutation = xAiBackgroundTaskLifecycleMutation(notification, status);
        return mutation === null ? Effect.void : apply(mutation);
      }),
    { discard: true },
  );

/** Sent on the parent session; will_wake means a subagent-completed-<id> turn follows. */
export interface XAiSubagentFinishedNotice {
  readonly sessionId: string;
  readonly childSessionId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly result: string | null;
}

export function xAiSubagentFinishedNotice(
  notification: XAiSessionUpdateNotification,
): XAiSubagentFinishedNotice | null {
  const update = notification.update;
  const childSessionId = nonEmptyString(update.child_session_id);
  if (update.sessionUpdate !== "subagent_finished" || childSessionId === undefined) return null;
  const status = update.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled") return null;
  const text = status === "completed" ? update.output : update.error;
  return {
    sessionId: notification.sessionId,
    childSessionId,
    status,
    result: nonEmptyString(text ?? undefined) ?? null,
  };
}

export const registerXAiSubagentFinished = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "handleExtNotification">,
  finish: (notice: XAiSubagentFinishedNotice) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.forEach(
    xAiSessionNotificationMethods,
    (method) =>
      runtime.handleExtNotification(method, XAiSessionUpdateNotification, (notification) => {
        const notice = xAiSubagentFinishedNotice(notification);
        return notice === null ? Effect.void : finish(notice);
      }),
    { discard: true },
  );
