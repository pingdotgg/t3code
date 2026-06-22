import {
  isToolLifecycleItemType,
  type OrchestrationThreadActivity,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";

import { TOOL_ICONS } from "./icons.ts";

// Derive the per-turn "work log" (tool calls / thinking) from a thread's activity
// stream — a trimmed port of the web client's session-logic.deriveWorkLogEntries.
// Pure: the timeline interleaves these with messages and MessagesTimeline renders
// each as a compact icon + label + preview + status row, matching the web UI.

export type WorkLogTone = "thinking" | "tool" | "info" | "error";
export type WorkLogStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";
export type WorkLogStatusKind = "success" | "failure" | "neutral" | "progress";

export interface WorkLogEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId: string | null;
  readonly label: string;
  readonly tone: WorkLogTone;
  readonly detail?: string;
  readonly command?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly toolTitle?: string;
  readonly itemType?: ToolLifecycleItemType;
  readonly requestKind?: "command" | "file-read" | "file-change";
  readonly toolCallId?: string;
  readonly toolLifecycleStatus?: WorkLogStatus;
  // Internal lifecycle bookkeeping kept for collapsing consecutive updates.
  readonly activityKind: string;
  readonly collapseKey?: string;
}

type MutableEntry = {
  -readonly [K in keyof WorkLogEntry]: WorkLogEntry[K];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Split a trailing "<exited with exit code N>" marker off a command's captured output. */
function stripTrailingExitCode(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(trimmed);
  if (!match?.groups) return trimmed.length > 0 ? trimmed : null;
  const output = match.groups.output?.trim() ?? "";
  return output.length > 0 ? output : null;
}

function normalizeCommandValue(value: unknown): string | null {
  if (typeof value === "string") return asTrimmedString(value);
  if (Array.isArray(value)) {
    const joined = value.filter((part) => typeof part === "string").join(" ");
    return asTrimmedString(joined);
  }
  return null;
}

/** Strip the " complete"/" completed" suffix some providers append to tool labels. */
export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    itemType === "command_execution" && detail ? stripTrailingExitCode(detail) : null,
  ];
  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (command) return command;
  }
  return null;
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail) : null;
  if (detail && detail.toLowerCase() !== heading.trim().toLowerCase()) return detail;

  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  if (rawOutput) {
    const totalFiles = asNumber(rawOutput.totalFiles);
    if (totalFiles !== null) {
      const suffix = rawOutput.truncated === true ? "+" : "";
      return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? "" : "s"}${suffix}`;
    }
  }
  return null;
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): ToolLifecycleItemType | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return undefined;
}

function extractToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogStatus | undefined {
  const s = payload?.status;
  if (
    s === "inProgress" ||
    s === "completed" ||
    s === "failed" ||
    s === "declined" ||
    s === "stopped"
  ) {
    return s;
  }
  return undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) return;
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);
  for (const key of ["item", "result", "input", "data", "changes", "files", "edits", "patch", "patches", "operations"]) {
    if (!(key in record)) continue;
    collectChangedFiles(record[key], target, seen, depth + 1);
    if (target.length >= 12) return;
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const files: string[] = [];
  collectChangedFiles(asRecord(payload?.data), files, new Set<string>(), 0);
  return files;
}

function compareByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return left.id.localeCompare(right.id);
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") return false;
  const payload = asRecord(activity.payload);
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function toEntry(activity: OrchestrationThreadActivity): MutableEntry {
  const payload = asRecord(activity.payload);
  const title = asTrimmedString(payload?.title);
  const isTask = activity.kind === "task.progress" || activity.kind === "task.completed";
  const taskLabel = isTask ? asTrimmedString(payload?.summary) ?? asTrimmedString(payload?.detail) : null;
  const command = isTask ? null : extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const toolCallId = isTask ? null : asTrimmedString(asRecord(payload?.data)?.toolCallId);

  const entry: MutableEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: taskLabel ?? activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };

  const detail = extractToolDetail(payload, title ?? activity.summary);
  if (detail) entry.detail = detail;
  if (command) entry.command = command;
  if (changedFiles.length > 0) entry.changedFiles = changedFiles;
  if (title) entry.toolTitle = title;
  if (itemType) entry.itemType = itemType;
  if (requestKind) entry.requestKind = requestKind;
  if (toolCallId) entry.toolCallId = toolCallId;

  let status = extractToolLifecycleStatus(payload);
  if (!status && activity.kind === "tool.completed") status = "completed";
  if (status) entry.toolLifecycleStatus = status;

  const collapseKey = collapseKeyFor(entry);
  if (collapseKey) entry.collapseKey = collapseKey;
  return entry;
}

function collapseKeyFor(entry: MutableEntry): string | undefined {
  if (entry.activityKind !== "tool.updated" && entry.activityKind !== "tool.completed") {
    return undefined;
  }
  if (entry.toolCallId) return `tool:${entry.toolCallId}`;
  const label = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (label.length === 0 && detail.length === 0 && itemType.length === 0) return undefined;
  return [itemType, label, detail].join("");
}

function shouldCollapse(previous: MutableEntry, next: MutableEntry): boolean {
  if (previous.activityKind !== "tool.updated" && previous.activityKind !== "tool.completed") {
    return false;
  }
  if (next.activityKind !== "tool.updated" && next.activityKind !== "tool.completed") return false;
  if (previous.activityKind === "tool.completed") return false;
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) return true;
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
}

function merge(previous: MutableEntry, next: MutableEntry): MutableEntry {
  // Entries only carry a key when its value is defined, so a plain spread already
  // implements "next wins if present, else previous" for every optional field.
  const merged: MutableEntry = { ...previous, ...next };
  const changedFiles = [...new Set([...(previous.changedFiles ?? []), ...(next.changedFiles ?? [])])];
  if (changedFiles.length > 0) merged.changedFiles = changedFiles;
  return merged;
}

/** Skip these non-renderable lifecycle/bookkeeping activities. */
function isHiddenActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "tool.started" ||
    activity.kind === "task.started" ||
    activity.kind === "context-window.updated" ||
    activity.summary === "Checkpoint captured" ||
    isPlanBoundaryToolActivity(activity)
  );
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  const ordered = [...activities].sort(compareByOrder);
  const collapsed: MutableEntry[] = [];
  for (const activity of ordered) {
    if (isHiddenActivity(activity)) continue;
    const entry = toEntry(activity);
    const previous = collapsed.at(-1);
    if (previous && shouldCollapse(previous, entry)) {
      collapsed[collapsed.length - 1] = merge(previous, entry);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

// ── View helpers (pure; MessagesTimeline maps the result to palette colors) ──

/** A single glyph standing in for the web UI's per-tool lucide icon (see icons.ts). */
export function workLogIcon(entry: WorkLogEntry): string {
  if (entry.tone === "thinking") return TOOL_ICONS.thinking.glyph;
  if (entry.tone === "error") return TOOL_ICONS.error.glyph;
  switch (entry.itemType) {
    case "command_execution":
      return TOOL_ICONS.terminal.glyph;
    case "file_change":
      return TOOL_ICONS.fileChange.glyph;
    case "image_view":
      return TOOL_ICONS.imageView.glyph;
    case "web_search":
      return TOOL_ICONS.webSearch.glyph;
    case "mcp_tool_call":
      return TOOL_ICONS.mcp.glyph;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return TOOL_ICONS.dynamic.glyph;
    default:
      break;
  }
  if (entry.requestKind === "command") return TOOL_ICONS.terminal.glyph;
  if (entry.requestKind === "file-change") return TOOL_ICONS.fileChange.glyph;
  if (entry.requestKind === "file-read") return TOOL_ICONS.fileRead.glyph;
  return TOOL_ICONS.default.glyph;
}

export function workLogStatusKind(entry: WorkLogEntry): WorkLogStatusKind {
  switch (entry.toolLifecycleStatus) {
    case "completed":
      return "success";
    case "failed":
      return "failure";
    case "declined":
    case "stopped":
      return "neutral";
    case "inProgress":
      return "progress";
    default:
      return "neutral";
  }
}

export function workLogLabel(entry: WorkLogEntry): string {
  return normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
}

/** The muted single-line preview: command, else detail, else "file +N more". */
export function workLogPreview(entry: WorkLogEntry): string | null {
  if (entry.command) return entry.command;
  if (entry.detail) return entry.detail;
  const files = entry.changedFiles;
  if (files && files.length > 0) {
    return files.length === 1 ? files[0]! : `${files[0]} +${files.length - 1} more`;
  }
  return null;
}
