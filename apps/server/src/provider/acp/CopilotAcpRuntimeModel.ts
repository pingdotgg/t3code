import type { ToolLifecycleItemType } from "@t3tools/contracts";
import { deriveToolActivityPresentation } from "@t3tools/shared/toolActivity";

import {
  parsePermissionRequest,
  type AcpParsedSessionEvent,
  type AcpPermissionRequest,
  type AcpPlanUpdate,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function getPath(value: unknown, path: ReadonlyArray<string>): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function normalizeSearchText(...values: ReadonlyArray<unknown>): string {
  return values
    .flatMap((value) => {
      if (typeof value === "string") {
        return [value];
      }
      if (Array.isArray(value)) {
        return value.flatMap((entry) => (typeof entry === "string" ? [entry] : []));
      }
      if (isRecord(value)) {
        return Object.values(value).flatMap((entry) => (typeof entry === "string" ? [entry] : []));
      }
      return [];
    })
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, " ")
    .trim();
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.map(asString).filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommand(
  rawInput: unknown,
  existingCommand: string | undefined,
): string | undefined {
  if (!isRecord(rawInput)) {
    return existingCommand;
  }
  const direct =
    normalizeCommandValue(rawInput.command) ??
    normalizeCommandValue(rawInput.cmd) ??
    normalizeCommandValue(rawInput.commandLine);
  if (direct) {
    return direct;
  }
  const executable = asString(rawInput.executable) ?? asString(rawInput.program);
  const args = normalizeCommandValue(rawInput.args) ?? normalizeCommandValue(rawInput.arguments);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  return executable ?? existingCommand;
}

function extractCopilotToolName(toolCall: AcpToolCallState): string | undefined {
  return (
    asString(getPath(toolCall.data, ["_meta", "claudeCode", "toolName"])) ??
    asString(getPath(toolCall.data, ["rawInput", "_meta", "claudeCode", "toolName"])) ??
    asString(getPath(toolCall.data, ["rawInput", "toolName"])) ??
    asString(getPath(toolCall.data, ["rawInput", "name"])) ??
    asString(getPath(toolCall.data, ["rawInput", "tool"])) ??
    asString(toolCall.kind) ??
    asString(toolCall.title) ??
    asString(toolCall.toolCallId)
  );
}

function classifyCopilotTool(input: {
  readonly toolName: string | undefined;
  readonly toolCall: AcpToolCallState;
}): { readonly itemType: ToolLifecycleItemType; readonly kind: string | undefined } {
  const rawInput = asRecord(input.toolCall.data.rawInput);
  const text = normalizeSearchText(
    input.toolName,
    input.toolCall.toolCallId,
    input.toolCall.title,
    input.toolCall.kind,
    rawInput?.command,
    rawInput?.query,
    rawInput?.path,
    rawInput?.filePath,
  );

  if (
    /\b(?:bash|shell|terminal|execute|exec|run_command|runcommand|command)\b/u.test(text) ||
    extractCommand(rawInput, input.toolCall.command) !== undefined
  ) {
    return { itemType: "command_execution", kind: "execute" };
  }

  if (
    /\b(?:write|edit|delete|move|patch|replace|create_file|multiedit|notebookedit)\b/u.test(text)
  ) {
    return { itemType: "file_change", kind: inferFileKind(text) };
  }

  if (/\b(?:web_search|websearch|search|grep|fetch|read_url|webfetch|browse)\b/u.test(text)) {
    return { itemType: "web_search", kind: text.includes("fetch") ? "fetch" : "search" };
  }

  if (/\b(?:task|subagent|sub_agent|agent)\b/u.test(text)) {
    return { itemType: "collab_agent_tool_call", kind: "subagent" };
  }

  return { itemType: "dynamic_tool_call", kind: input.toolCall.kind };
}

function inferFileKind(text: string): string {
  if (/\bdelete\b/u.test(text)) return "delete";
  if (/\bmove\b/u.test(text)) return "move";
  if (/\bwrite|create_file\b/u.test(text)) return "write";
  return "edit";
}

function normalizeTitle(
  toolName: string | undefined,
  existingTitle: string | undefined,
  toolCallId: string,
): string {
  return (toolName !== toolCallId ? toolName : undefined) ?? existingTitle ?? "Tool";
}

export function normalizeCopilotToolCallState(toolCall: AcpToolCallState): AcpToolCallState {
  const rawInput = asRecord(toolCall.data.rawInput);
  const toolName = extractCopilotToolName(toolCall);
  const classification = classifyCopilotTool({ toolName, toolCall });
  const command = extractCommand(rawInput, toolCall.command);
  const nextData = {
    ...toolCall.data,
    ...(toolName ? { copilotToolName: toolName } : {}),
    itemType: classification.itemType,
    ...(classification.kind ? { kind: classification.kind } : {}),
    ...(command ? { command } : {}),
  };
  const title = normalizeTitle(toolName, toolCall.title, toolCall.toolCallId);
  const presentation = deriveToolActivityPresentation({
    itemType: classification.itemType,
    title,
    detail: command ?? toolCall.detail,
    data: nextData,
    fallbackSummary: title,
  });

  return {
    ...toolCall,
    itemType: classification.itemType,
    ...(classification.kind ? { kind: classification.kind } : {}),
    title: presentation.summary,
    ...(command ? { command } : {}),
    ...(presentation.detail ? { detail: presentation.detail } : {}),
    data: nextData,
  };
}

function normalizeTodoStatus(raw: unknown): "pending" | "inProgress" | "completed" {
  const value = asString(raw)?.toLowerCase();
  switch (value) {
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "in_progress":
    case "inprogress":
    case "doing":
    case "active":
      return "inProgress";
    default:
      return "pending";
  }
}

function todoText(todo: Record<string, unknown>, index: number): string {
  return (
    asString(todo.content) ??
    asString(todo.text) ??
    asString(todo.title) ??
    asString(todo.task) ??
    asString(todo.description) ??
    `Step ${index + 1}`
  );
}

function parseTodoArray(value: unknown): AcpPlanUpdate | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const plan = value.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      return [];
    }
    return [
      {
        step: todoText(entry, index),
        status: normalizeTodoStatus(entry.status ?? entry.state),
      },
    ];
  });
  return plan.length > 0 ? { plan } : undefined;
}

function extractTodosFromValue(value: unknown): AcpPlanUpdate | undefined {
  if (Array.isArray(value)) {
    return parseTodoArray(value);
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return (
    parseTodoArray(record.todos) ??
    parseTodoArray(record.todoList) ??
    parseTodoArray(record.items) ??
    parseTodoArray(record.tasks)
  );
}

function parseMarkdownPlan(content: string): AcpPlanUpdate | undefined {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const plan = lines.flatMap((line) => {
    const checkbox = /^[-*]\s+\[(?<mark>[ xX-])\]\s+(?<text>.+)$/u.exec(line);
    const checkboxText = checkbox?.groups?.text?.trim();
    const checkboxMark = checkbox?.groups?.mark;
    if (checkboxText && checkboxMark) {
      return [
        {
          step: checkboxText,
          status:
            checkboxMark.toLowerCase() === "x"
              ? ("completed" as const)
              : checkboxMark === "-"
                ? ("inProgress" as const)
                : ("pending" as const),
        },
      ];
    }
    const bullet = /^[-*]\s+(?<text>.+)$/u.exec(line);
    return bullet?.groups?.text
      ? [{ step: bullet.groups.text.trim(), status: "pending" as const }]
      : [];
  });
  return plan.length > 0 ? { plan } : undefined;
}

function isPlanPath(value: unknown): boolean {
  const path = asString(value)?.toLowerCase();
  return !!path && /(?:^|[/\\._-])plan(?:[/\\._-]|$)/u.test(path);
}

export function extractCopilotPlanUpdate(toolCall: AcpToolCallState): AcpPlanUpdate | undefined {
  const rawInput = asRecord(toolCall.data.rawInput);
  const rawOutput = asRecord(toolCall.data.rawOutput);
  const todos = extractTodosFromValue(rawInput) ?? extractTodosFromValue(rawOutput);
  if (todos) {
    return todos;
  }

  const path = rawInput?.path ?? rawInput?.filePath ?? rawInput?.filename;
  const content =
    asString(rawInput?.content) ?? asString(rawInput?.text) ?? asString(rawInput?.newText);
  if (!isPlanPath(path) || !content) {
    return undefined;
  }
  return parseMarkdownPlan(content);
}

function hasReasoningMarker(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  const text = normalizeSearchText(
    record.kind,
    record.type,
    record.role,
    record.streamKind,
    record.name,
  );
  return /\b(?:thought|thinking|reasoning|chain_of_thought)\b/u.test(text);
}

export function shouldSuppressCopilotContentDelta(event: AcpParsedSessionEvent): boolean {
  if (event._tag !== "ContentDelta") {
    return false;
  }
  const raw = asRecord(event.rawPayload);
  const update = asRecord(raw?.update);
  const content = asRecord(update?.content);
  return hasReasoningMarker(update?._meta) || hasReasoningMarker(content?._meta);
}

export function normalizeCopilotParsedSessionEvent(
  event: AcpParsedSessionEvent,
): ReadonlyArray<AcpParsedSessionEvent> {
  if (shouldSuppressCopilotContentDelta(event)) {
    return [];
  }
  if (event._tag !== "ToolCallUpdated") {
    return [event];
  }
  return [
    {
      ...event,
      toolCall: normalizeCopilotToolCallState(event.toolCall),
    },
  ];
}

/**
 * Detects the upstream Copilot CLI failure mode where the model API rejects a
 * request because a previous tool call's output was never delivered (CAPIError
 * 400 "No tool output found for function call …"). When this surfaces as an
 * `agent_message_chunk`, the Copilot CLI's per-session conversation state is
 * permanently broken — every subsequent prompt on the same session/thread will
 * fail with the same error until the CLI process is restarted with a fresh
 * session. The adapter uses this detector to abort the in-flight turn,
 * surface a clear error to the user, and reset the CLI process.
 */
export interface CopilotFatalToolCallError {
  readonly callId: string;
  readonly statusCode: string;
  readonly requestId: string | undefined;
  readonly originalText: string;
}

const COPILOT_FATAL_TOOL_CALL_ERROR_PATTERN =
  /Execution failed:\s*CAPIError:\s*(?<status>\d+)\s+No tool output found for function call\s+(?<call>\S+?)\.\s*(?:\(Request ID:\s*(?<request>[^)]+)\))?/u;

export function detectCopilotFatalToolCallError(
  text: string,
): CopilotFatalToolCallError | undefined {
  const match = COPILOT_FATAL_TOOL_CALL_ERROR_PATTERN.exec(text);
  if (!match?.groups) {
    return undefined;
  }
  const { status, call, request } = match.groups;
  if (!status || !call) {
    return undefined;
  }
  return {
    callId: call,
    statusCode: status,
    requestId: request?.trim() || undefined,
    originalText: text,
  };
}

export function copilotFatalToolCallErrorMessage(error: CopilotFatalToolCallError): string {
  return (
    `Copilot CLI hit a fatal API error and the conversation can no longer continue. ` +
    `(CAPIError ${error.statusCode}: missing tool output for ${error.callId}.) ` +
    `Start a new thread to continue working with Copilot.`
  );
}

export function normalizeCopilotPermissionRequest(
  params: Parameters<typeof parsePermissionRequest>[0],
): AcpPermissionRequest {
  const parsed = parsePermissionRequest(params);
  if (!parsed.toolCall) {
    return parsed;
  }
  const toolCall = normalizeCopilotToolCallState(parsed.toolCall);
  return {
    ...parsed,
    kind: toolCall.kind ?? parsed.kind,
    ...(toolCall.detail ? { detail: toolCall.detail } : {}),
    toolCall,
  };
}
