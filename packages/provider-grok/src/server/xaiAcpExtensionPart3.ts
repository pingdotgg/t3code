import * as Schema from "effect/Schema";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type { XAiAcpBackgroundToolMutation, XAiAcpSubagentEndNotice, XAiAcpSubagentUpdate } from "./xaiAcpExtensionPart2.ts";
import { XAI_UUID_RE, decodeByteText, extractXAiChildSessionId, firstUuidMatch, isXAiAsyncSpawnAck, isXAiGetSubagentOutputTool, isXAiMonitorStartAck, isXAiMonitorTool, isXAiSpawnOrTaskTool, nonEmptyString, unknownRecord, xAiBackgroundShellTaskId, xAiToolOutputText } from "./xaiAcpExtensionPart2.ts";
import { trimmed } from "./xaiAcpExtension.ts";

function isGenericAcpToolTitle(title: string | undefined): boolean {
  const key = (title ?? "").trim().toLowerCase();
  return key.length === 0 || key === "tool" || key === "tool call" || key === "terminal";
}

function resolveXAiAcpToolTitle(toolCall: AcpToolCallState): string | undefined {
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

/** Grok 1.0.41 monitor ticks report exit_code 0 before ending via _x.ai/task_completed. */
export function normalizeXAiAcpToolCallState(toolCall: AcpToolCallState): AcpToolCallState {
  const resolvedTitle = resolveXAiAcpToolTitle(toolCall);
  const withTitle =
    resolvedTitle !== undefined && resolvedTitle !== toolCall.title
      ? { ...toolCall, title: resolvedTitle }
      : toolCall;

  const rawOutput = unknownRecord(withTitle.data.rawOutput);
  const outputType = nonEmptyString(rawOutput?.type)?.toLowerCase();
  const reportedRunning = withTitle.status === "inProgress" || withTitle.status === "pending";
  if (outputType === "bash" && !reportedRunning) {
    // Keep exit-code keys aligned with adapter commandExitCode.
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
  if (xAiBackgroundShellTaskId(withTitle) !== undefined) {
    return { ...withTitle, status: "inProgress" };
  }
  if (!isXAiMonitorTool(withTitle)) {
    return withTitle;
  }
  if (outputType === "monitor") {
    return { ...withTitle, status: "inProgress" };
  }
  const output = xAiToolOutputText(withTitle);
  if (withTitle.status === "completed" && isXAiMonitorStartAck(output)) {
    return { ...withTitle, status: "inProgress" };
  }
  return withTitle;
}

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
    // Only the monitor header describes outcome; output can contain error words without failure.
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
  // Skip balanced descriptor parentheses so nested titles cannot supply false outcome verbs.
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

export function structuredTaskIdFromGetOutputTool(toolCall: AcpToolCallState): string | undefined {
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  const result = unknownRecord(rawOutput?.Result) ?? unknownRecord(rawOutput?.result);
  return (
    nonEmptyString(result?.task_id) ??
    nonEmptyString(result?.taskId) ??
    nonEmptyString(rawOutput?.task_id) ??
    nonEmptyString(rawOutput?.taskId)
  );
}

export function resultTaskIdFromGetOutputTool(
  toolCall: AcpToolCallState,
  output: string | undefined,
): string | undefined {
  const structured = structuredTaskIdFromGetOutputTool(toolCall);
  if (structured !== undefined && new RegExp(`^${XAI_UUID_RE}$`, "i").test(structured)) {
    return structured;
  }
  if (output === undefined) return undefined;
  const taskHeader = firstUuidMatch(
    output,
    new RegExp(`===\\s*Task\\s+(${XAI_UUID_RE})\\s*===`, "i"),
  );
  return taskHeader;
}

export function resultFromGetOutputTool(
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

export function statusFromGetOutputTool(
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
  // A completed poll RPC does not end its task without task-level status or exit code.
  return "running";
}

/** Spawn ACKs return immediately; keep subagents running until a child or hydration terminal. */
export function extractXAiAcpSubagentUpdate(
  toolCall: AcpToolCallState,
): XAiAcpSubagentUpdate | undefined {
  const rawInput = unknownRecord(toolCall.data.rawInput);
  const output = xAiToolOutputText(toolCall);

  if (isXAiGetSubagentOutputTool(toolCall, rawInput)) {
    const structuredTaskId = structuredTaskIdFromGetOutputTool(toolCall);
    if (
      structuredTaskId !== undefined &&
      !new RegExp(`^${XAI_UUID_RE}$`, "i").test(structuredTaskId)
    ) {
      return undefined;
    }
    const taskIds = taskIdsFromGetOutputTool(toolCall, rawInput);
    const childSessionId =
      resultTaskIdFromGetOutputTool(toolCall, output) ??
      taskIds[0] ??
      extractXAiChildSessionId(output);
    if (childSessionId === null) return undefined;
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

export type XAiAskUserQuestionRequestParams = typeof XAiAskUserQuestionParams.Type;
export type XAiAskUserQuestionRequest = typeof XAiAskUserQuestionRequest.Type;

const XAiExitPlanModeParams = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  planContent: Schema.optional(Schema.NullOr(Schema.String)),
});

const XAiWrappedExitPlanModeParams = Schema.Struct({
  method: Schema.Literals(["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"]),
  params: XAiExitPlanModeParams,
});

export const XAiExitPlanModeRequest = Schema.Union([
  XAiExitPlanModeParams,
  XAiWrappedExitPlanModeParams,
]);

type XAiExitPlanModeRequestParams = typeof XAiExitPlanModeParams.Type;
export type XAiExitPlanModeRequest = typeof XAiExitPlanModeRequest.Type;

function unwrapExitPlanModeParams(params: XAiExitPlanModeRequest): XAiExitPlanModeRequestParams {
  return "params" in params ? params.params : params;
}

export const XAI_EMPTY_PLAN_MARKDOWN =
  "# No plan written yet\n\n(The agent exited plan mode without writing a plan.)";

export function extractXAiExitPlanMarkdown(
  params: XAiExitPlanModeRequest,
  fallback?: string | null,
): string {
  const content = unwrapExitPlanModeParams(params).planContent;
  const fromRequest = typeof content === "string" ? trimmed(content) : undefined;
  if (fromRequest) {
    return fromRequest;
  }
  const fromFallback = fallback?.trim();
  if (fromFallback && fromFallback.length > 0) {
    return fromFallback;
  }
  return XAI_EMPTY_PLAN_MARKDOWN;
}

export type XAiExitPlanModeOutcome = "approved" | "abandoned" | "request_changes";

export interface XAiExitPlanModeResponse {
  readonly outcome: XAiExitPlanModeOutcome;
  readonly feedback?: string;
}

/** Abandon the native approval gate after T3 captures the plan; implementation uses T3 UI. */
export function makeXAiExitPlanModeCapturedResponse(feedback?: string): XAiExitPlanModeResponse {
  return {
    outcome: "abandoned",
    feedback:
      feedback ??
      "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
  };
}

function normalizeFsPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function pathHasTraversalSegment(normalized: string): boolean {
  return normalized.split("/").includes("..");
}

function addGrokSessionPrefix(
  prefixes: Set<string>,
  homeOrRoot: string,
  nestedGrokDir: boolean,
): void {
  const root = normalizeFsPath(homeOrRoot);
  if (!root) {
    return;
  }
  prefixes.add(nestedGrokDir ? `${root}/.grok/sessions/` : `${root}/sessions/`);
}

export interface GrokPlanPathHost {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}

export function grokPlanSessionPrefixes(host: GrokPlanPathHost): ReadonlySet<string> {
  const { environment } = host;
  const prefixes = new Set<string>();
  addGrokSessionPrefix(prefixes, host.homeDirectory, true);
  addGrokSessionPrefix(prefixes, "~", true);
  addGrokSessionPrefix(prefixes, environment.HOME ?? "", true);
  addGrokSessionPrefix(prefixes, environment.USERPROFILE ?? "", true);
  // ACP mock and isolated Grok spawns use a HOME that is not the server process home.
  addGrokSessionPrefix(prefixes, "/tmp/mock-home", true);
  const grokHome = environment.GROK_HOME ?? "";
  addGrokSessionPrefix(prefixes, grokHome, false);
  addGrokSessionPrefix(prefixes, grokHome, true);
  return prefixes;
}

export const CANONICAL_HOME_GROK_SESSION_PATH =
  /^(?:\/home\/[^/]+|\/Users\/[^/]+|[a-zA-Z]:\/Users\/[^/]+)\/\.grok\/sessions\/(?:[^/]+\/)+plan\.md$/;

export const CASE_INSENSITIVE_CANONICAL_HOME_GROK_SESSION_PATH = new RegExp(
  CANONICAL_HOME_GROK_SESSION_PATH.source,
  "i",
);
