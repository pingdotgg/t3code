/**
 * providerHandoffTranscript - Renders a thread's neutral message log into a
 * plain-text prelude for provider handoffs.
 *
 * When a thread switches to a provider whose resume state is incompatible with
 * the previous one (different driver or continuation key), the new provider
 * session starts with no context: conversation history lives in each
 * provider's own session state, not in anything the next provider can resume.
 * This prelude is prepended to the first turn sent to the new provider so it
 * can pick the conversation up from the orchestration layer's own record.
 *
 * The prelude interleaves the user/assistant messages with a compact trail of
 * the tool activity (commands run, files changed, MCP/skill calls and their
 * output) so the new provider inherits the actual work done, not just the
 * previous assistant's prose summary of it.
 *
 * @module providerHandoffTranscript
 */
import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";

export const HANDOFF_TRANSCRIPT_MAX_CHARS = 80_000;
const TOOL_OUTPUT_MAX_CHARS = 600;
const TOOL_SUBJECT_MAX_CHARS = 300;
const MAX_CHANGED_FILES = 12;

const HANDOFF_HEADER = [
  "[Conversation handoff]",
  "You are taking over an existing conversation that was previously handled by a different AI assistant.",
  'The transcript below is the conversation so far. "User:" lines are from the user; "Assistant:" lines were written by the previous assistant.',
  'Lines in [brackets] are the tools the previous assistant invoked — shell commands ("$"), file edits ("edit"), file reads ("read"), MCP/skill/other tool calls — with their exit status and output. Treat them as a log of work already performed.',
  "--- transcript start ---",
].join("\n");

const HANDOFF_FOOTER = [
  "--- transcript end ---",
  "Continue this conversation naturally from where it left off. The workspace already reflects any changes above. Do not introduce yourself again and do not mention this handoff unless the user asks about it.",
].join("\n");

const TRUNCATION_NOTICE = "[Older history omitted for length]";
const ENTRY_SEPARATOR = "\n\n";

interface TranscriptEntry {
  readonly createdAt: string;
  readonly text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}

/**
 * A tool call surfaces as several activities (started → updated → completed).
 * This key groups them so only the richest single line survives per call.
 */
function toolCallGroupKey(activity: OrchestrationThreadActivity, payload: Record<string, unknown>) {
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  return (
    asNonEmptyString(payload.toolCallId) ??
    asNonEmptyString(payload.callId) ??
    asNonEmptyString(payload.id) ??
    asNonEmptyString(data?.toolCallId) ??
    asNonEmptyString(item?.id) ??
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

/**
 * A tool call's terminal lifecycle event (`tool.completed` / `task.completed`)
 * carries the real exit code and output; an in-progress `tool.updated` does not.
 * When collapsing a group we prefer the terminal event so a verbose partial
 * update can't shadow the shorter-but-authoritative final result.
 */
function isTerminalToolActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.kind === "tool.completed" || activity.kind === "task.completed";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toolItem(payload: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(asRecord(payload.data)?.item);
}

function toolItemType(payload: Record<string, unknown>): string | null {
  return asNonEmptyString(payload.itemType) ?? asNonEmptyString(toolItem(payload)?.type);
}

/** Strip a trailing `<exited with exit code N>` marker that some providers append. */
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

function toolCommand(payload: Record<string, unknown>): string | null {
  const item = toolItem(payload);
  const input = asRecord(item?.input);
  const detail = stripExitMarker(asNonEmptyString(payload.detail));
  return (
    asNonEmptyString(item?.command) ??
    asNonEmptyString(input?.command) ??
    (toolItemType(payload) === "command_execution" ? detail.text : null)
  );
}

function toolExitCode(payload: Record<string, unknown>): number | null {
  const rawOutput = asRecord(asRecord(payload.data)?.rawOutput);
  return (
    asFiniteNumber(toolItem(payload)?.exitCode) ??
    asFiniteNumber(rawOutput?.exitCode) ??
    stripExitMarker(asNonEmptyString(payload.detail)).exitCode
  );
}

function pushFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asNonEmptyString(value);
  if (normalized && !seen.has(normalized)) {
    seen.add(normalized);
    target.push(normalized);
  }
}

/** Walk the raw provider item collecting touched file paths (bounded). */
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
  const record = asRecord(value);
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

function toolChangedFiles(payload: Record<string, unknown>): string[] {
  const files: string[] = [];
  collectFiles(asRecord(payload.data), files, new Set<string>(), 0);
  return files;
}

function toolStatus(payload: Record<string, unknown>): string | null {
  return asNonEmptyString(payload.status) ?? asNonEmptyString(toolItem(payload)?.status);
}

/** Best-effort extraction of a tool's *output* (as opposed to its invocation). */
function toolOutput(payload: Record<string, unknown>, command: string | null): string | null {
  const data = asRecord(payload.data);
  const item = toolItem(payload);
  const rawOutput = asRecord(data?.rawOutput);
  const detailText = stripExitMarker(asNonEmptyString(payload.detail)).text;
  const candidates = [
    item?.aggregatedOutput,
    data?.aggregatedOutput,
    rawOutput?.content,
    rawOutput?.stdout,
    item?.output,
    data?.output,
    item?.stdout,
    data?.stdout,
    // stderr matters most for failed commands, whose diagnostics often land
    // only there — otherwise a non-zero exit would carry no error text.
    rawOutput?.stderr,
    item?.stderr,
    data?.stderr,
    // `detail` doubles as output only when it isn't just the command label.
    detailText && detailText !== command ? detailText : null,
  ];
  for (const candidate of candidates) {
    const text = asNonEmptyString(candidate);
    if (text) {
      return truncate(text, TOOL_OUTPUT_MAX_CHARS);
    }
  }
  const totalFiles = asFiniteNumber(rawOutput?.totalFiles);
  if (totalFiles !== null) {
    return `${totalFiles} file${totalFiles === 1 ? "" : "s"}${rawOutput?.truncated === true ? "+" : ""}`;
  }
  return null;
}

/**
 * Map a tool activity to a short `tag` (how the timeline categorises it) and a
 * `subject` (what it acted on: a command, file list, or tool name).
 */
function describeTool(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): { tag: string; subject: string } | null {
  const itemType = toolItemType(payload);
  const command = toolCommand(payload);
  const files = toolChangedFiles(payload);
  const fileList = files.length > 0 ? files.join(", ") : null;
  const title = asNonEmptyString(payload.title) ?? asNonEmptyString(activity.summary);

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
  const payload = asRecord(activity.payload) ?? {};
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
  // Keep one line per tool call. A terminal event (tool.completed /
  // task.completed) carries the authoritative exit code and output, so it
  // always wins over a non-terminal tool.updated — even a verbose in-progress
  // update that happens to be longer. Ties (same terminality) fall back to the
  // most detailed (longest) line.
  const byGroup = new Map<string, { entry: TranscriptEntry; terminal: boolean }>();
  for (const activity of activities) {
    if (!isToolTrailActivity(activity)) {
      continue;
    }
    const line = buildToolTrailLine(activity);
    if (!line) {
      continue;
    }
    const key = toolCallGroupKey(activity, asRecord(activity.payload) ?? {});
    const terminal = isTerminalToolActivity(activity);
    const existing = byGroup.get(key);
    const shouldReplace =
      !existing ||
      (terminal && !existing.terminal) ||
      (terminal === existing.terminal && line.length > existing.entry.text.length);
    if (shouldReplace) {
      byGroup.set(key, { entry: { createdAt: activity.createdAt, text: line }, terminal });
    }
  }
  return Array.from(byGroup.values()).map((value) => value.entry);
}

/**
 * Render the prior conversation (messages + tool trail) as a handoff prelude,
 * keeping the most recent entries that fit within `maxChars`. Returns
 * `undefined` when there is nothing worth handing off.
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

  // A tool line shares its turn's timestamp with the surrounding messages;
  // ties keep insertion order, which is close enough to causal order.
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

  const truncated = kept.length < entries.length;
  return [HANDOFF_HEADER, ...(truncated ? [TRUNCATION_NOTICE] : []), ...kept, HANDOFF_FOOTER].join(
    ENTRY_SEPARATOR,
  );
}
