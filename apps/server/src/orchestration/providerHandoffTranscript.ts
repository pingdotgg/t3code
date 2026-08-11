/**
 * Renders the orchestration read model into a provider-neutral prelude.
 *
 * Provider-native resume cursors cannot cross driver or continuation
 * boundaries. A fresh destination session receives this prelude on its first
 * turn so it can continue from T3 Code's canonical conversation and tool log.
 */
import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export const HANDOFF_TRANSCRIPT_MAX_CHARS = 80_000;
const TOOL_OUTPUT_MAX_CHARS = 600;
const TOOL_SUBJECT_MAX_CHARS = 300;
const MAX_CHANGED_FILES = 12;

const HANDOFF_HEADER = [
  "[Conversation handoff]",
  "You are taking over an existing conversation that was previously handled by a different AI assistant.",
  'The transcript below is the conversation so far. "User:" lines are from the user; "Assistant:" lines were written by the previous assistant.',
  'Lines in [brackets] are tools the previous assistant invoked, including commands ("$"), file edits ("edit"), reads, MCP calls, and other tools. Treat them as a log of work already performed.',
  "--- transcript start ---",
].join("\n");

const HANDOFF_FOOTER = [
  "--- transcript end ---",
  "Continue naturally from where the conversation left off. The workspace already reflects any changes above. Do not introduce yourself again or mention this handoff unless the user asks.",
].join("\n");

const TRUNCATION_NOTICE = "[Older history omitted for length]";
const ENTRY_SEPARATOR = "\n\n";

interface TranscriptEntry {
  readonly createdAt: string;
  readonly text: string;
}

function recordOrNull(value: unknown): Record<PropertyKey, unknown> | null {
  return Predicate.isObject(value) ? value : null;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}

function toolCallGroupKey(
  activity: OrchestrationThreadActivity,
  payload: Record<PropertyKey, unknown>,
) {
  const data = recordOrNull(payload.data);
  const item = recordOrNull(data?.item);
  return (
    nonEmptyStringOrNull(payload.toolCallId) ??
    nonEmptyStringOrNull(payload.callId) ??
    nonEmptyStringOrNull(payload.id) ??
    nonEmptyStringOrNull(data?.toolCallId) ??
    nonEmptyStringOrNull(item?.id) ??
    activity.id
  );
}

function isToolTrailActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "tool.updated" ||
    activity.kind === "tool.completed" ||
    activity.kind === "task.completed"
  );
}

function isTerminalToolActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.kind === "tool.completed" || activity.kind === "task.completed";
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toolItem(payload: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> | null {
  return recordOrNull(recordOrNull(payload.data)?.item);
}

function toolItemType(payload: Record<PropertyKey, unknown>): string | null {
  return nonEmptyStringOrNull(payload.itemType) ?? nonEmptyStringOrNull(toolItem(payload)?.type);
}

function stripExitMarker(value: string | null): { text: string | null; exitCode: number | null } {
  if (!value) {
    return { text: null, exitCode: null };
  }
  const match = /^([\s\S]*?)(?:\s*<exited with exit code (\d+)>)\s*$/i.exec(value.trim());
  if (!match) {
    return { text: value.trim() || null, exitCode: null };
  }
  return {
    text: match[1]!.trim() || null,
    exitCode: Number.parseInt(match[2]!, 10),
  };
}

function toolCommand(payload: Record<PropertyKey, unknown>): string | null {
  const item = toolItem(payload);
  const input = recordOrNull(item?.input);
  const detail = stripExitMarker(nonEmptyStringOrNull(payload.detail));
  return (
    nonEmptyStringOrNull(item?.command) ??
    nonEmptyStringOrNull(input?.command) ??
    (toolItemType(payload) === "command_execution" ? detail.text : null)
  );
}

function toolExitCode(payload: Record<PropertyKey, unknown>): number | null {
  const rawOutput = recordOrNull(recordOrNull(payload.data)?.rawOutput);
  return (
    finiteNumberOrNull(toolItem(payload)?.exitCode) ??
    finiteNumberOrNull(rawOutput?.exitCode) ??
    stripExitMarker(nonEmptyStringOrNull(payload.detail)).exitCode
  );
}

function pushFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = nonEmptyStringOrNull(value);
  if (normalized && !seen.has(normalized)) {
    seen.add(normalized);
    target.push(normalized);
  }
}

function collectFiles(value: unknown, target: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || target.length >= MAX_CHANGED_FILES) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFiles(entry, target, seen, depth + 1);
      if (target.length >= MAX_CHANGED_FILES) return;
    }
    return;
  }
  const record = recordOrNull(value);
  if (!record) {
    return;
  }
  pushFile(target, seen, record.path);
  pushFile(target, seen, record.filePath);
  pushFile(target, seen, record.relativePath);
  pushFile(target, seen, record.newPath);
  pushFile(target, seen, record.oldPath);
  for (const key of ["item", "result", "input", "changes", "files", "edits", "patches"]) {
    if (key in record) {
      collectFiles(record[key], target, seen, depth + 1);
      if (target.length >= MAX_CHANGED_FILES) return;
    }
  }
}

function toolChangedFiles(payload: Record<PropertyKey, unknown>): string[] {
  const files: string[] = [];
  collectFiles(recordOrNull(payload.data), files, new Set<string>(), 0);
  return files;
}

function toolStatus(payload: Record<PropertyKey, unknown>): string | null {
  return nonEmptyStringOrNull(payload.status) ?? nonEmptyStringOrNull(toolItem(payload)?.status);
}

function toolOutput(payload: Record<PropertyKey, unknown>, command: string | null): string | null {
  const data = recordOrNull(payload.data);
  const item = toolItem(payload);
  const rawOutput = recordOrNull(data?.rawOutput);
  const detailText = stripExitMarker(nonEmptyStringOrNull(payload.detail)).text;
  const candidates = [
    item?.aggregatedOutput,
    data?.aggregatedOutput,
    rawOutput?.content,
    rawOutput?.stdout,
    item?.output,
    data?.output,
    item?.stdout,
    data?.stdout,
    rawOutput?.stderr,
    item?.stderr,
    data?.stderr,
    detailText && detailText !== command ? detailText : null,
  ];
  for (const candidate of candidates) {
    const text = nonEmptyStringOrNull(candidate);
    if (text) {
      return truncate(text, TOOL_OUTPUT_MAX_CHARS);
    }
  }
  const totalFiles = finiteNumberOrNull(rawOutput?.totalFiles);
  if (totalFiles !== null) {
    return `${totalFiles} file${totalFiles === 1 ? "" : "s"}${rawOutput?.truncated === true ? "+" : ""}`;
  }
  return null;
}

function describeTool(
  activity: OrchestrationThreadActivity,
  payload: Record<PropertyKey, unknown>,
): { tag: string; subject: string } | null {
  const itemType = toolItemType(payload);
  const command = toolCommand(payload);
  const files = toolChangedFiles(payload);
  const fileList = files.length > 0 ? files.join(", ") : null;
  const title = nonEmptyStringOrNull(payload.title) ?? nonEmptyStringOrNull(activity.summary);

  if (activity.kind === "task.completed") {
    return title ? { tag: "task", subject: title } : null;
  }

  let tag: string;
  let subject: string | null;
  switch (itemType) {
    case "command_execution":
      tag = "$";
      subject = command ?? title;
      break;
    case "file_change":
      tag = "edit";
      subject = fileList ?? title;
      break;
    case "mcp_tool_call":
      tag = "mcp";
      subject = title ?? command;
      break;
    case "web_search":
      tag = "search";
      subject = title ?? command;
      break;
    case "image_view":
      tag = "view";
      subject = fileList ?? title;
      break;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      tag = "tool";
      subject = title ?? command ?? fileList;
      break;
    default:
      tag = "tool";
      subject = command ?? fileList ?? title;
      break;
  }
  return subject ? { tag, subject: truncate(subject, TOOL_SUBJECT_MAX_CHARS) } : null;
}

function buildToolTrailLine(activity: OrchestrationThreadActivity): string | null {
  const payload = recordOrNull(activity.payload) ?? {};
  const described = describeTool(activity, payload);
  if (!described) {
    return null;
  }
  const command = toolCommand(payload);
  const exitCode = toolExitCode(payload);
  const status = toolStatus(payload)?.toLowerCase();
  const statusSuffix =
    exitCode !== null
      ? ` (exit ${exitCode})`
      : status === "failed" || status === "error" || status === "declined"
        ? ` (${status})`
        : "";
  const output = toolOutput(payload, command);
  return `[${described.tag}] ${described.subject}${statusSuffix}${output ? `\n→ ${output}` : ""}`;
}

function collectToolTrailEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TranscriptEntry[] {
  const byGroup = new Map<string, { entry: TranscriptEntry; terminal: boolean }>();
  for (const activity of activities) {
    if (!isToolTrailActivity(activity)) {
      continue;
    }
    const line = buildToolTrailLine(activity);
    if (!line) {
      continue;
    }
    const key = toolCallGroupKey(activity, recordOrNull(activity.payload) ?? {});
    const terminal = isTerminalToolActivity(activity);
    const existing = byGroup.get(key);
    if (
      !existing ||
      (terminal && !existing.terminal) ||
      (terminal === existing.terminal && line.length > existing.entry.text.length)
    ) {
      byGroup.set(key, { entry: { createdAt: activity.createdAt, text: line }, terminal });
    }
  }
  return Array.from(byGroup.values()).map((value) => value.entry);
}

/**
 * Keeps the newest complete entries that fit `maxChars`. The in-flight user
 * message must be excluded because the caller appends it after this prelude.
 */
export function renderProviderHandoffPrelude(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
  readonly excludeMessageId?: string;
  readonly maxChars?: number;
}): string | undefined {
  const maxChars = input.maxChars ?? HANDOFF_TRANSCRIPT_MAX_CHARS;
  const messageEntries: TranscriptEntry[] = input.messages
    .filter((message) => message.id !== input.excludeMessageId)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      createdAt: message.createdAt,
      text: `${message.role === "user" ? "User" : "Assistant"}:\n${message.text.trim()}`,
      hasText: message.text.trim().length > 0,
    }))
    .filter((entry) => entry.hasText)
    .map(({ createdAt, text }) => ({ createdAt, text }));

  const toolEntries = collectToolTrailEntries(input.activities ?? []);
  if (messageEntries.length === 0 && toolEntries.length === 0) {
    return undefined;
  }

  const entries = [...messageEntries, ...toolEntries]
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((entry) => entry.text);
  const frameCost =
    HANDOFF_HEADER.length +
    HANDOFF_FOOTER.length +
    TRUNCATION_NOTICE.length +
    ENTRY_SEPARATOR.length * 3;
  const entryBudget = maxChars - frameCost;
  if (entryBudget <= 0) {
    return undefined;
  }

  const kept: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    const cost = entry.length + ENTRY_SEPARATOR.length;
    if (used + cost > entryBudget) {
      break;
    }
    kept.unshift(entry);
    used += cost;
  }
  if (kept.length === 0) {
    return undefined;
  }

  return [
    HANDOFF_HEADER,
    ...(kept.length < entries.length ? [TRUNCATION_NOTICE] : []),
    ...kept,
    HANDOFF_FOOTER,
  ].join(ENTRY_SEPARATOR);
}
