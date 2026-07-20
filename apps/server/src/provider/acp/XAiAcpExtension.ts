import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

const xAiStopReasonMissingMetaKey = "xAiStopReasonMissing";
const completedXAiPromptIdLimit = 128;

const XAiPromptCompleteNotification = Schema.Struct({
  sessionId: Schema.String,
  promptId: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  agentResult: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

type XAiPromptCompleteNotification = typeof XAiPromptCompleteNotification.Type;

/**
 * Grok persists root turn completion as an extension session update:
 * `{ params: { sessionId, update: {
 *   sessionUpdate: "turn_completed", prompt_id, stop_reason } } }`.
 * The open-source runtime forwards it as `x.ai/session_notification` and
 * stores/replays it as `_x.ai/session/update`; released 0.2.106 forwards the
 * underscore alias `_x.ai/session_notification`. Current source also emits
 * the fire-and-forget canonical `x.ai/session/prompt_complete`, while released
 * builds use the underscore alias.
 */
const XAiSessionUpdateNotification = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Struct({
    sessionUpdate: Schema.String,
    prompt_id: Schema.optional(Schema.String),
    promptId: Schema.optional(Schema.String),
    stop_reason: Schema.optional(Schema.String),
    stopReason: Schema.optional(Schema.String),
  }),
  _meta: Schema.optional(Schema.Unknown),
});

type XAiSessionUpdateNotification = typeof XAiSessionUpdateNotification.Type;

const XAI_TASK_COMPLETED_PROMPT_ID_PREFIX = "task-completed-";

/**
 * Map a Grok `_x.ai/session/update` payload to a prompt-complete shape when it
 * is a root `turn_completed` for a real prompt id. Returns null for hooks,
 * background task completions, and other update kinds.
 */
export function xAiPromptCompleteFromSessionUpdate(
  notification: XAiSessionUpdateNotification,
): XAiPromptCompleteNotification | null {
  const update = notification.update;
  if (update.sessionUpdate !== "turn_completed") {
    return null;
  }
  const promptId = nonEmptyString(update.prompt_id) ?? nonEmptyString(update.promptId);
  // Require prompt id so we never session-fallback match a background task
  // completion (`task-completed-*`) or an unrelated CLI turn.
  if (promptId === undefined || promptId.startsWith(XAI_TASK_COMPLETED_PROMPT_ID_PREFIX)) {
    return null;
  }
  const stopReason = nonEmptyString(update.stop_reason) ?? nonEmptyString(update.stopReason);
  return {
    sessionId: notification.sessionId,
    promptId,
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}

interface PendingXAiPromptCompletion {
  readonly sessionId: string;
  readonly promptId: string;
  readonly deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse>;
}

export interface XAiAcpSubagentUpdate {
  readonly nativeTaskId: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly status: "running" | "completed" | "failed";
  readonly childSessionId: string | null;
  readonly result: string | null;
  /**
   * When false, the ACP adapter also projects a normal tool turn item for this
   * tool call (used for get_command_or_subagent_output hydration). Default true.
   */
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

const XAI_UUID_RE = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function titleKey(toolCall: AcpToolCallState): string {
  return (toolCall.title ?? "").trim().toLowerCase();
}

function decodeByteText(value: unknown): string | undefined {
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

function xAiToolOutputText(toolCall: AcpToolCallState): string | undefined {
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

function firstUuidMatch(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match?.[1];
}

function extractXAiChildSessionId(output: string | undefined): string | null {
  if (output === undefined) return null;
  return (
    firstUuidMatch(output, new RegExp(`(?:^|\\n)\\s*Agent ID:\\s*(${XAI_UUID_RE})\\b`, "i")) ??
    firstUuidMatch(output, new RegExp(`(?:^|\\n)\\s*subagent_id:\\s*(${XAI_UUID_RE})\\b`, "i")) ??
    firstUuidMatch(output, new RegExp(`===\\s*Task\\s+(${XAI_UUID_RE})\\s*===`, "i")) ??
    null
  );
}

function isXAiAsyncSpawnAck(output: string | undefined): boolean {
  if (output === undefined) return false;
  if (/subagent started in background/i.test(output)) return true;
  return (
    new RegExp(`subagent_id:\\s*${XAI_UUID_RE}`, "i").test(output) &&
    /get_command_or_subagent_output/i.test(output)
  );
}

function isXAiMonitorStartAck(output: string | undefined): boolean {
  if (output === undefined) return false;
  return /monitor started\s*\(\s*task\s+/i.test(output);
}

function isXAiSpawnOrTaskTool(
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

function isXAiGetSubagentOutputTool(
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
  // ACP often titles this tool with the finished subagent label.
  if (title.startsWith("[subagent:") && Array.isArray(rawInput?.task_ids)) return true;
  return false;
}

export function isXAiMonitorTool(toolCall: AcpToolCallState): boolean {
  const title = titleKey(toolCall);
  if (title === "monitor" || title.startsWith("monitor ")) return true;
  const rawInput = unknownRecord(toolCall.data.rawInput);
  const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
  if (variant === "monitor") return true;
  // Live start ACKs often keep a generic title ("Tool") and only mark the
  // structured envelope as Monitor; title rewrite to description must not
  // prevent monitor registration / inProgress forcing.
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  const outputType = nonEmptyString(rawOutput?.type)?.toLowerCase();
  return outputType === "monitor";
}

export function extractXAiMonitorTaskId(toolCall: AcpToolCallState): string | undefined {
  if (!isXAiMonitorTool(toolCall)) return undefined;
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  // Live ACP start ACK: { type: "Monitor", taskId, timeoutMs, persistent }
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

/**
 * Live Monitor start ACK `{ type: "Monitor", persistent: true }` (or matching
 * rawInput). Persistent monitors should not hold root-turn deferred finalize.
 */
export function isXAiPersistentMonitor(toolCall: AcpToolCallState): boolean {
  if (!isXAiMonitorTool(toolCall)) return false;
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  if (rawOutput !== undefined && nonEmptyString(rawOutput.type)?.toLowerCase() === "monitor") {
    return rawOutput.persistent === true;
  }
  const rawInput = unknownRecord(toolCall.data.rawInput);
  return rawInput?.persistent === true;
}

/**
 * When get_command_or_subagent_output / TaskOutput completes registered monitor
 * task(s), return hydration for each completed background tool id.
 */
export function extractXAiBackgroundTaskCompletion(toolCall: AcpToolCallState): ReadonlyArray<{
  readonly taskId: string;
  readonly status: "running" | "completed" | "failed";
  readonly appendOutput: string;
}> {
  const rawInput = unknownRecord(toolCall.data.rawInput);
  if (!isXAiGetSubagentOutputTool(toolCall, rawInput)) return [];
  // Caller matches taskId against registered background tools (monitors).
  // Subagent hydration stays on extractXAiAcpSubagentUpdate.
  const text = xAiToolOutputText(toolCall);
  const status = statusFromGetOutputTool(toolCall, text);
  const appendOutput = resultFromGetOutputTool(toolCall, text) ?? "";
  // Prefer the completed identity from the result/header over the request list
  // (one call can poll multiple task_ids).
  const resultTaskId = resultTaskIdFromGetOutputTool(toolCall, text);
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
 * task id it names: the Grok CLI emits no `x.ai/task_completed` for a killed
 * task. A failed kill usually means the task was already gone, so it ends the
 * id too (failing open to a continuation beats pinning the running set).
 */
export function extractXAiKilledBackgroundTasks(toolCall: AcpToolCallState): ReadonlyArray<{
  readonly taskId: string;
  readonly status: "running" | "completed" | "failed";
  readonly appendOutput: string;
}> {
  const title = titleKey(toolCall);
  const rawInput = unknownRecord(toolCall.data.rawInput);
  const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
  if (!title.includes("kill_command_or_subagent") && variant !== "kill") return [];
  if (toolCall.status !== "completed" && toolCall.status !== "failed") return [];
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
    task_snapshot: Schema.optional(
      Schema.Struct({
        task_id: Schema.optional(Schema.String),
      }),
    ),
  }),
  _meta: Schema.optional(Schema.Unknown),
});

type XAiTaskLifecycleNotification = typeof XAiTaskLifecycleNotification.Type;

export interface XAiBackgroundTaskLifecycleMutation {
  readonly sessionId: string;
  readonly taskId: string;
  readonly status: "running" | "completed";
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
  return { sessionId: notification.sessionId, taskId, status };
}

/**
 * Grok task lifecycle notifications use canonical `x.ai/task_*` methods in
 * current builds; older 0.2.x builds used `_x.ai/task_*`. Interactive cancel
 * preserves tasks that were already backgrounded (and some older builds could
 * background the cancelled foreground command), so both spellings must be
 * tracked. Residual frames then buffer instead of waking synthetic
 * continuations, and pending-background-work stays truthful until the task
 * ends (or the model kills it via kill_command_or_subagent).
 */
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

/**
 * Grok ACP often sends `title: "Tool"` even when rawInput has a useful
 * description or variant (especially Monitor). Prefer description/variant so
 * the timeline matches Claude-style tool names rather than a generic label.
 */
export function isGenericAcpToolTitle(title: string | undefined): boolean {
  const key = (title ?? "").trim().toLowerCase();
  return key.length === 0 || key === "tool" || key === "tool call" || key === "terminal";
}

export function resolveXAiAcpToolTitle(toolCall: AcpToolCallState): string | undefined {
  if (!isGenericAcpToolTitle(toolCall.title)) {
    return nonEmptyString(toolCall.title);
  }
  const rawInput = unknownRecord(toolCall.data.rawInput);
  const description = nonEmptyString(rawInput?.description);
  const variant = nonEmptyString(rawInput?.variant)?.toLowerCase();
  if (description !== undefined) {
    if (variant === "monitor" && !description.toLowerCase().startsWith("monitor")) {
      return `Monitor: ${description}`;
    }
    return description;
  }
  if (variant === "monitor") return "Monitor";
  if (variant === "task" || variant === "cursortask" || variant === "spawn_subagent") {
    return "Task";
  }
  if (variant === "taskoutput" || variant === "task_output") return "Task output";
  if (variant !== undefined) {
    return variant;
  }
  const command =
    nonEmptyString(rawInput?.command) ??
    nonEmptyString(unknownRecord(toolCall.data.rawOutput)?.command);
  if (command !== undefined) {
    return command.length > 80 ? `${command.slice(0, 77)}...` : command;
  }
  return nonEmptyString(toolCall.title);
}

/**
 * Normalize Grok ACP tool presentation and monitor lifecycle:
 * - replace generic titles ("Tool") with description / variant labels
 * - structured Monitor start ACK stays running
 * - text start ACK stays running
 * - structured Bash results with exit_code are terminal (any tool: post-settle
 *   wake re-reports of a finished monitor arrive with empty rawInput and a
 *   generic title, so monitor detection cannot match; without this they replay
 *   as running and the timeline row spins forever)
 */
export function normalizeXAiAcpToolCallState(toolCall: AcpToolCallState): AcpToolCallState {
  const resolvedTitle = resolveXAiAcpToolTitle(toolCall);
  const withTitle =
    resolvedTitle !== undefined && resolvedTitle !== toolCall.title
      ? { ...toolCall, title: resolvedTitle }
      : toolCall;

  const rawOutput = unknownRecord(withTitle.data.rawOutput);
  const outputType = nonEmptyString(rawOutput?.type)?.toLowerCase();
  if (outputType === "bash") {
    // Same key set as the adapter's command projection (commandExitCode).
    const exitCode = ["exit_code", "exitCode", "code"]
      .map((key) => rawOutput?.[key])
      .find((value) => typeof value === "number" && Number.isInteger(value));
    if (typeof exitCode === "number") {
      if (exitCode === 0 && (xAiToolOutputText(withTitle)?.trim().length ?? 0) === 0) {
        return { ...withTitle, status: "inProgress" };
      }
      return {
        ...withTitle,
        status: exitCode === 0 ? "completed" : "failed",
      };
    }
  }
  if (!isXAiMonitorTool(withTitle)) {
    return withTitle;
  }
  if (outputType === "monitor") {
    // Start registration only; process still running in the background.
    return { ...withTitle, status: "inProgress" };
  }
  const output = xAiToolOutputText(withTitle);
  if (withTitle.status === "completed" && isXAiMonitorStartAck(output)) {
    return { ...withTitle, status: "inProgress" };
  }
  return withTitle;
}

/**
 * Parse Grok synthetic monitor traffic that arrives as root text chunks
 * (`<monitor-event>` lines, batched `<monitor>` event blocks, and
 * "Monitor ... ended" reminders). Coalesced chunks may contain several events;
 * return every match so later progress / end notices are not dropped.
 */
export function extractXAiAcpBackgroundToolMutation(
  text: string,
): ReadonlyArray<XAiAcpBackgroundToolMutation> {
  const mutations: XAiAcpBackgroundToolMutation[] = [];

  const eventRe = new RegExp(
    `<monitor-event\\s+task_id=["']?(${XAI_UUID_RE})["']?\\s*>\\s*([\\s\\S]*?)\\s*</monitor-event>`,
    "gi",
  );
  for (const eventMatch of text.matchAll(eventRe)) {
    if (eventMatch[1] === undefined) continue;
    const line = (eventMatch[2] ?? "").trim();
    mutations.push({
      taskId: eventMatch[1],
      status: "running",
      appendOutput: line.length > 0 ? `${line}\n` : "",
    });
  }

  // Batched form: "N monitor events from 1 monitor ...:\n<monitor
  // description="..." task_id="...">\n[1] line\n</monitor>". Still a running
  // monitor; must track and filter like single-event chatter.
  const batchedRe = new RegExp(
    `<monitor\\s[^>]*task_id=["']?(${XAI_UUID_RE})["']?[^>]*>\\s*([\\s\\S]*?)\\s*</monitor>`,
    "gi",
  );
  for (const batchedMatch of text.matchAll(batchedRe)) {
    if (batchedMatch[1] === undefined) continue;
    const lines = (batchedMatch[2] ?? "").trim();
    mutations.push({
      taskId: batchedMatch[1],
      status: "running",
      appendOutput: lines.length > 0 ? `${lines}\n` : "",
    });
  }

  const endedRe = new RegExp(`Monitor\\s+["']?(${XAI_UUID_RE})["']?\\s+ended`, "gi");
  for (const endedMatch of text.matchAll(endedRe)) {
    if (endedMatch[1] === undefined) continue;
    // Only the "Monitor … ended …" clause is outcome text. Description/output
    // after the header can contain words like "error" without meaning failure.
    const outcomeClause = (endedMatch[0] ?? "").trim();
    const afterHeader = text.slice((endedMatch.index ?? 0) + endedMatch[0].length);
    const outcomeTail = afterHeader.split(/\n/)[0] ?? "";
    const outcome = `${outcomeClause}${outcomeTail}`;
    const summary = text.replace(/<\/?system-reminder>/gi, "").trim();
    mutations.push({
      taskId: endedMatch[1],
      status:
        /exited\s*\(\s*code\s*0\s*\)/i.test(outcome) || /ended cleanly/i.test(outcome)
          ? "completed"
          : /exited|failed|error|signal/i.test(outcome)
            ? "failed"
            : "completed",
      appendOutput: summary.length > 0 ? `${summary}\n` : "Monitor ended.\n",
    });
  }

  return mutations;
}

/**
 * Parse Grok's root-session subagent end reminder ("Background subagent
 * "<uuid>" (general-purpose: "...") completed successfully."). The agent is
 * free to skip get_command_or_subagent_output hydration, so this reminder can
 * be the only terminal signal for the subagent row; a row stuck on running
 * holds deferred finalize (and the whole run) open until harness timeout.
 */
function stripLeadingBalancedParenGroup(text: string): string {
  const trimmed = text.replace(/^\s+/, "");
  if (!trimmed.startsWith("(")) return trimmed;
  let depth = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(index + 1).replace(/^\s+/, "");
    }
  }
  return trimmed;
}

export function extractXAiAcpSubagentEndNotice(text: string): XAiAcpSubagentEndNotice | undefined {
  const match = text.match(new RegExp(`Background subagent\\s+["']?(${XAI_UUID_RE})["']?`, "i"));
  if (match?.[1] === undefined) return undefined;
  // Skip the parenthesized descriptor (subagent type and title) so its words
  // cannot masquerade as the outcome verb. Balance parens so nested titles
  // like `(general-purpose: "Check (backend) failed")` do not leak.
  const tail = stripLeadingBalancedParenGroup(text.slice((match.index ?? 0) + match[0].length));
  if (/completed successfully/i.test(tail)) {
    return { childSessionId: match[1], status: "completed" };
  }
  if (/\b(failed|errored|error|crashed|cancelled|canceled|interrupted|timed out)\b/i.test(tail)) {
    return { childSessionId: match[1], status: "failed" };
  }
  if (/\b(completed|finished|ended)\b/i.test(tail)) {
    return { childSessionId: match[1], status: "completed" };
  }
  return undefined;
}

function taskIdsFromGetOutputTool(
  toolCall: AcpToolCallState,
  rawInput: Record<string, unknown> | undefined,
): ReadonlyArray<string> {
  const ids: string[] = [];
  const push = (value: unknown) => {
    const text = nonEmptyString(value);
    if (text !== undefined && new RegExp(`^${XAI_UUID_RE}$`, "i").test(text)) {
      ids.push(text);
    }
  };
  if (Array.isArray(rawInput?.task_ids)) {
    for (const entry of rawInput.task_ids) push(entry);
  }
  push(rawInput?.task_id);
  push(rawInput?.taskId);
  const resultId = resultTaskIdFromGetOutputTool(toolCall, xAiToolOutputText(toolCall));
  if (resultId !== undefined) ids.push(resultId);
  return [...new Set(ids)];
}

/** Identity of the task the get_output envelope actually reports (not the request list). */
function resultTaskIdFromGetOutputTool(
  toolCall: AcpToolCallState,
  output: string | undefined,
): string | undefined {
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  const result = unknownRecord(rawOutput?.Result) ?? unknownRecord(rawOutput?.result);
  const structured =
    nonEmptyString(result?.task_id) ??
    nonEmptyString(result?.taskId) ??
    nonEmptyString(rawOutput?.task_id) ??
    nonEmptyString(rawOutput?.taskId);
  if (structured !== undefined && new RegExp(`^${XAI_UUID_RE}$`, "i").test(structured)) {
    return structured;
  }
  if (output === undefined) return undefined;
  const taskHeader = firstUuidMatch(
    output,
    new RegExp(`===\\s*Task\\s+(${XAI_UUID_RE})\\s*===`, "i"),
  );
  if (taskHeader !== undefined) return taskHeader;
  return firstUuidMatch(output, new RegExp(`subagent_id:\\s*(${XAI_UUID_RE})\\b`, "i"));
}

function resultFromGetOutputTool(
  toolCall: AcpToolCallState,
  output: string | undefined,
): string | null {
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  const result = unknownRecord(rawOutput?.Result) ?? unknownRecord(rawOutput?.result);
  const structured =
    nonEmptyString(result?.output) ??
    nonEmptyString(result?.text) ??
    decodeByteText(result?.output);
  if (structured !== undefined) {
    // Drop trailing machine meta blocks when present.
    const cleaned = structured
      .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/gi, "")
      .replace(/<subagent_result>[\s\S]*?<\/subagent_result>/gi, "")
      .trim();
    if (cleaned.length > 0) return cleaned;
    return null;
  }
  if (output === undefined) return null;
  const marker = output.match(/=== Output ===\s*([\s\S]*)$/i);
  const body = (marker?.[1] ?? output).trim();
  return body.length > 0 ? body : null;
}

function statusFromGetOutputTool(
  toolCall: AcpToolCallState,
  output: string | undefined,
): "running" | "completed" | "failed" {
  if (toolCall.status === "failed") return "failed";
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  const result = unknownRecord(rawOutput?.Result) ?? unknownRecord(rawOutput?.result);
  const structuredStatus = nonEmptyString(result?.status)?.toLowerCase();
  if (structuredStatus === "completed" || structuredStatus === "success") return "completed";
  if (structuredStatus === "failed" || structuredStatus === "error") return "failed";
  if (structuredStatus === "running" || structuredStatus === "pending") return "running";
  if (typeof result?.exit_code === "number") {
    return result.exit_code === 0 ? "completed" : "failed";
  }
  if (output !== undefined) {
    if (/Status:\s*failed/i.test(output) || /Exit Code:\s*-?(?!0\b)\d+/i.test(output)) {
      return "failed";
    }
    if (/Status:\s*completed/i.test(output) || /Status:\s*success/i.test(output)) {
      return "completed";
    }
    if (/Status:\s*running/i.test(output) || /Status:\s*pending/i.test(output)) {
      return "running";
    }
  }
  return toolCall.status === "completed" ? "completed" : "running";
}

/**
 * Recognizes Grok Task / spawn_subagent envelopes and get_command hydration
 * without teaching the generic ACP adapter about xAI tool names.
 *
 * Current Grok CLI returns spawn_subagent immediately with a background ACK
 * (`subagent_id: ...`). That must stay `running` until child work finishes or
 * get_command_or_subagent_output reports a terminal status.
 */
export function extractXAiAcpSubagentUpdate(
  toolCall: AcpToolCallState,
): XAiAcpSubagentUpdate | undefined {
  const rawInput = unknownRecord(toolCall.data.rawInput);
  const output = xAiToolOutputText(toolCall);

  if (isXAiGetSubagentOutputTool(toolCall, rawInput)) {
    const taskIds = taskIdsFromGetOutputTool(toolCall, rawInput);
    // Prefer the completed task identity from the result/header over the first
    // requested task_ids entry (one call can poll multiple task_ids).
    const childSessionId =
      resultTaskIdFromGetOutputTool(toolCall, output) ??
      taskIds[0] ??
      extractXAiChildSessionId(output);
    if (childSessionId === null) return undefined;
    // Prefer the durable subagent row as the completion surface (Claude/Codex
    // style). Suppress the noisy TaskOutput tool card; monitor hydration is
    // handled separately via extractBackgroundTaskCompletion.
    return {
      nativeTaskId: toolCall.toolCallId,
      prompt: "",
      title: null,
      model: null,
      status: statusFromGetOutputTool(toolCall, output),
      childSessionId,
      result: resultFromGetOutputTool(toolCall, output),
      suppressNormalTool: true,
    };
  }

  if (!isXAiSpawnOrTaskTool(toolCall, rawInput)) return undefined;

  const childSessionId = extractXAiChildSessionId(output);
  const asyncSpawnAck = isXAiAsyncSpawnAck(output);
  const legacyResult =
    output
      ?.replace(new RegExp(`(?:^|\\n)\\s*Agent ID:\\s*${XAI_UUID_RE}[^\\n]*(?:\\n|$)`, "gi"), "\n")
      .replace(
        new RegExp(`(?:^|\\n)\\s*subagent_id:\\s*${XAI_UUID_RE}[^\\n]*(?:\\n|$)`, "gi"),
        "\n",
      )
      .trim() || null;

  let status: "running" | "completed" | "failed";
  if (toolCall.status === "failed") {
    status = "failed";
  } else if (asyncSpawnAck) {
    // Spawn RPC completed, but the child is still running.
    status = "running";
  } else if (toolCall.status === "completed") {
    status = "completed";
  } else {
    status = "running";
  }

  return {
    nativeTaskId: toolCall.toolCallId,
    prompt: nonEmptyString(rawInput?.prompt) ?? "",
    title: nonEmptyString(rawInput?.description) ?? null,
    model: nonEmptyString(rawInput?.model) ?? null,
    status,
    childSessionId,
    result: asyncSpawnAck ? null : legacyResult,
    suppressNormalTool: true,
  };
}

const XAiAskUserQuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});

const XAiAskUserQuestion = Schema.Struct({
  id: Schema.optional(Schema.String),
  question: Schema.String,
  options: Schema.Array(XAiAskUserQuestionOption),
  multiSelect: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const XAiAskUserQuestionParams = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  questions: Schema.Array(XAiAskUserQuestion),
  mode: Schema.Literals(["default", "plan"]),
});

const XAiWrappedAskUserQuestionParams = Schema.Struct({
  method: Schema.Literals(["x.ai/ask_user_question", "_x.ai/ask_user_question"]),
  params: XAiAskUserQuestionParams,
});

export const XAiAskUserQuestionRequest = Schema.Union([
  XAiAskUserQuestionParams,
  XAiWrappedAskUserQuestionParams,
]);

type XAiAskUserQuestionRequestParams = typeof XAiAskUserQuestionParams.Type;
type XAiAskUserQuestionRequest = typeof XAiAskUserQuestionRequest.Type;

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function unwrapAskUserQuestionParams(
  params: XAiAskUserQuestionRequest,
): XAiAskUserQuestionRequestParams {
  return "params" in params ? params.params : params;
}

export function extractXAiAskUserQuestions(
  params: XAiAskUserQuestionRequest,
): ReadonlyArray<UserInputQuestion> {
  return unwrapAskUserQuestionParams(params).questions.map((question) => ({
    id: question.id ?? question.question,
    header: "Question",
    question: question.question,
    multiSelect: question.multiSelect === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

export function extractXAiAskUserQuestionIdentity(params: XAiAskUserQuestionRequest): {
  readonly sessionId: string;
  readonly toolCallId: string;
} {
  const unwrapped = unwrapAskUserQuestionParams(params);
  return {
    sessionId: unwrapped.sessionId,
    toolCallId: unwrapped.toolCallId,
  };
}

interface XAiAskUserQuestionAnnotation {
  readonly preview?: string;
  readonly notes?: string;
}

interface XAiAskUserQuestionAcceptedResponse {
  readonly outcome: "accepted";
  readonly answers: Record<string, ReadonlyArray<string>>;
  readonly annotations?: Record<string, XAiAskUserQuestionAnnotation>;
}

interface XAiAskUserQuestionCancelledResponse {
  readonly outcome: "cancelled";
}

export type XAiAskUserQuestionResponse =
  | XAiAskUserQuestionAcceptedResponse
  | XAiAskUserQuestionCancelledResponse;

interface NormalizedXAiAnswer {
  readonly questionText: string;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly annotation?: XAiAskUserQuestionAnnotation;
}

function answerValues(answer: unknown): ReadonlyArray<string> {
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) => {
      const text = typeof entry === "string" ? trimmed(entry) : undefined;
      return text ? [text] : [];
    });
  }
  const text = typeof answer === "string" ? trimmed(answer) : undefined;
  return text ? [text] : [];
}

function normalizeAnswerForXAi(
  question: XAiAskUserQuestionRequestParams["questions"][number],
  answer: unknown,
): NormalizedXAiAnswer | undefined {
  const values = answerValues(answer);
  if (values.length === 0) {
    return undefined;
  }

  const optionByLabel = new Map(question.options.map((option) => [option.label, option]));
  const resolvedValues = values.map((value) => ({
    value,
    option: optionByLabel.get(value),
  }));
  const selectedLabels = resolvedValues.flatMap(({ option }) => (option ? [option.label] : []));
  const notes = resolvedValues.flatMap(({ option, value }) => (option ? [] : [value]));
  const preview =
    question.multiSelect === true
      ? undefined
      : resolvedValues.map(({ option }) => trimmed(option?.preview)).find((value) => value);

  const annotation =
    preview || notes.length > 0
      ? {
          ...(preview ? { preview } : {}),
          ...(notes.length > 0 ? { notes: notes.join("\n") } : {}),
        }
      : undefined;

  return {
    questionText: question.question,
    selectedLabels: selectedLabels.length > 0 ? selectedLabels : ["Other"],
    ...(annotation ? { annotation } : {}),
  };
}

function findQuestionAnswer(
  answers: ProviderUserInputAnswers,
  question: XAiAskUserQuestionRequestParams["questions"][number],
): unknown {
  const key = question.id ?? question.question;
  return answers[key] ?? answers[question.question];
}

export function makeXAiAskUserQuestionResponse(
  params: XAiAskUserQuestionRequest,
  answers: ProviderUserInputAnswers,
): XAiAskUserQuestionAcceptedResponse {
  const questions = unwrapAskUserQuestionParams(params).questions;
  const normalized = questions.flatMap((question) => {
    const entry = normalizeAnswerForXAi(question, findQuestionAnswer(answers, question));
    return entry ? [entry] : [];
  });
  const annotations = Object.fromEntries(
    normalized.flatMap((entry) =>
      entry.annotation ? [[entry.questionText, entry.annotation] as const] : [],
    ),
  );

  return {
    outcome: "accepted",
    answers: Object.fromEntries(
      normalized.map((entry) => [entry.questionText, entry.selectedLabels]),
    ),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

export function makeXAiAskUserQuestionCancelledResponse(): XAiAskUserQuestionCancelledResponse {
  return { outcome: "cancelled" };
}

function promptIdFromResponse(response: EffectAcpSchema.PromptResponse): string | undefined {
  const meta = response._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

function normalizeXAiStopReason(value: string | undefined): EffectAcpSchema.StopReason {
  switch (value) {
    case "cancelled":
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return value;
    default:
      return "end_turn";
  }
}

function promptResponseFromXAi(
  notification: XAiPromptCompleteNotification,
): EffectAcpSchema.PromptResponse {
  const stopReason = normalizeXAiStopReason(notification.stopReason);
  const meta: Record<string, unknown> = {
    sessionId: notification.sessionId,
  };
  if (notification.stopReason === undefined) {
    meta[xAiStopReasonMissingMetaKey] = true;
  }
  if (notification.promptId !== undefined) {
    meta.promptId = notification.promptId;
    meta.requestId = notification.promptId;
  }
  if (notification.agentResult !== undefined) {
    meta.agentResult = notification.agentResult;
  }
  return {
    stopReason,
    _meta: meta,
  };
}

const registerXAiPromptCompletionFallback = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  sessionId: string,
  promptId: string,
) =>
  Deferred.make<EffectAcpSchema.PromptResponse>().pipe(
    Effect.tap((deferred) =>
      Ref.update(pendingRef, (pending) => [...pending, { sessionId, promptId, deferred }]),
    ),
    Effect.map((deferred) => ({ deferred, promptId })),
  );

const unregisterXAiPromptCompletionFallback = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse>,
) => Ref.update(pendingRef, (pending) => pending.filter((entry) => entry.deferred !== deferred));

const abortPendingPromptCompletions = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  sessionId: string,
) =>
  Ref.modify(pendingRef, (pending) => {
    const [toAbort, remaining] = pending.reduce<
      [ReadonlyArray<PendingXAiPromptCompletion>, ReadonlyArray<PendingXAiPromptCompletion>]
    >(
      ([aborting, kept], entry) =>
        entry.sessionId === sessionId ? [[...aborting, entry], kept] : [aborting, [...kept, entry]],
      [[], []],
    );
    if (toAbort.length === 0) {
      return [Effect.void, pending] as const;
    }
    return [
      Effect.forEach(
        toAbort,
        (entry) =>
          Deferred.succeed(
            entry.deferred,
            promptResponseFromXAi({
              sessionId: entry.sessionId,
              promptId: entry.promptId,
              stopReason: "cancelled",
              agentResult: null,
            }),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
      remaining,
    ] as const;
  }).pipe(Effect.flatten);

const resolveXAiPromptCompletionFallback = ({
  pendingRef,
  completedPromptIdsRef,
  notification,
}: {
  readonly pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>;
  readonly completedPromptIdsRef: Ref.Ref<ReadonlyArray<string>>;
  readonly notification: XAiPromptCompleteNotification;
}) =>
  Ref.get(completedPromptIdsRef).pipe(
    Effect.flatMap((completedPromptIds) => {
      if (
        notification.promptId !== undefined &&
        completedPromptIds.includes(notification.promptId)
      ) {
        return Effect.void;
      }
      return Ref.modify(pendingRef, (pending) => {
        const index =
          notification.promptId !== undefined
            ? pending.findIndex(
                (entry) =>
                  entry.sessionId === notification.sessionId &&
                  entry.promptId === notification.promptId,
              )
            : (() => {
                const sessionPendingIndexes = pending.flatMap((entry, entryIndex) =>
                  entry.sessionId === notification.sessionId ? [entryIndex] : [],
                );
                if (sessionPendingIndexes.length !== 1) {
                  return -1;
                }
                return sessionPendingIndexes[0] ?? -1;
              })();
        if (index < 0) {
          return [Effect.void, pending] as const;
        }
        const entry = pending[index];
        if (!entry) {
          return [Effect.void, pending] as const;
        }
        return [
          Deferred.succeed(entry.deferred, promptResponseFromXAi(notification)).pipe(Effect.asVoid),
          [...pending.slice(0, index), ...pending.slice(index + 1)],
        ] as const;
      }).pipe(Effect.flatten);
    }),
  );

const rememberCompletedXAiPromptId = (
  completedPromptIdsRef: Ref.Ref<ReadonlyArray<string>>,
  response: EffectAcpSchema.PromptResponse,
  fallbackPromptId: string,
) => {
  const promptId = promptIdFromResponse(response) ?? fallbackPromptId;
  if (promptId.length === 0) {
    return Effect.void;
  }
  return Ref.update(completedPromptIdsRef, (completedPromptIds) => {
    if (completedPromptIds.includes(promptId)) {
      return completedPromptIds;
    }
    return [...completedPromptIds, promptId].slice(-completedXAiPromptIdLimit);
  });
};

/**
 * Grok-specific ACP runtime wrapper. Races `session/prompt` against root-matched
 * terminal notifications:
 * - session notification/update + `turn_completed` + matching `prompt_id`
 * - `x.ai/session/prompt_complete` (open-source fire-and-forget signal)
 * - `_x.ai/session/prompt_complete` (released-build alias)
 *
 * Pending entries are keyed by root sessionId + T3-injected promptId, so
 * foreign/child sessions and `task-completed-*` ids do not settle the root turn.
 */
export const makeXAiPromptCompletionRuntime = Effect.fn("makeXAiPromptCompletionRuntime")(
  function* (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) {
    let nextPromptFallbackId = 0;
    const allocatePromptFallbackId = Effect.sync(() => {
      nextPromptFallbackId += 1;
      return `t3-xai-prompt-${nextPromptFallbackId}`;
    });
    const pendingXAiPromptCompletionsRef = yield* Ref.make<
      ReadonlyArray<PendingXAiPromptCompletion>
    >([]);
    const completedXAiPromptIdsRef = yield* Ref.make<ReadonlyArray<string>>([]);

    const settleFromPromptComplete = (notification: XAiPromptCompleteNotification) =>
      resolveXAiPromptCompletionFallback({
        pendingRef: pendingXAiPromptCompletionsRef,
        completedPromptIdsRef: completedXAiPromptIdsRef,
        notification,
      }).pipe(Effect.catch(() => Effect.void));

    yield* Effect.forEach(
      ["x.ai/session/prompt_complete", "_x.ai/session/prompt_complete"] as const,
      (method) =>
        runtime.handleExtNotification(
          method,
          XAiPromptCompleteNotification,
          settleFromPromptComplete,
        ),
      { discard: true },
    );

    yield* Effect.forEach(
      ["x.ai/session_notification", "_x.ai/session_notification", "_x.ai/session/update"] as const,
      (method) =>
        runtime.handleExtNotification(method, XAiSessionUpdateNotification, (notification) => {
          const complete = xAiPromptCompleteFromSessionUpdate(notification);
          if (complete === null) {
            return Effect.void;
          }
          return settleFromPromptComplete(complete);
        }),
      { discard: true },
    );

    return {
      ...runtime,
      prompt: (payload) =>
        Effect.gen(function* () {
          const started = yield* runtime.start();
          const promptId = yield* allocatePromptFallbackId;
          const fallback = yield* registerXAiPromptCompletionFallback(
            pendingXAiPromptCompletionsRef,
            started.sessionId,
            promptId,
          );
          const cancelledResponse = promptResponseFromXAi({
            sessionId: started.sessionId,
            promptId: fallback.promptId,
            stopReason: "cancelled",
            agentResult: null,
          });
          const promptRpcFiber = yield* runtime
            .prompt({
              ...payload,
              _meta: {
                ...payload._meta,
                promptId: fallback.promptId,
                requestId: fallback.promptId,
              },
            })
            .pipe(Effect.forkChild);
          return yield* Effect.raceFirst(
            Fiber.join(promptRpcFiber).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.succeed(cancelledResponse)
                  : Effect.failCause(cause),
              ),
            ),
            Deferred.await(fallback.deferred),
          ).pipe(
            Effect.tap((response) =>
              rememberCompletedXAiPromptId(completedXAiPromptIdsRef, response, fallback.promptId),
            ),
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Fiber.interrupt(promptRpcFiber).pipe(Effect.ignore);
                yield* unregisterXAiPromptCompletionFallback(
                  pendingXAiPromptCompletionsRef,
                  fallback.deferred,
                );
              }),
            ),
          );
        }),
      cancel: Effect.gen(function* () {
        const started = yield* runtime.start();
        yield* abortPendingPromptCompletions(pendingXAiPromptCompletionsRef, started.sessionId);
        yield* runtime.cancel;
      }),
    } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
  },
);

export function promptResponseHasMissingXAiStopReason(
  response: EffectAcpSchema.PromptResponse,
): boolean {
  const meta = response._meta;
  return meta !== null && typeof meta === "object" && meta[xAiStopReasonMissingMetaKey] === true;
}
