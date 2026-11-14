import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import {
  resolveWorkEntryToolPresentation,
  toolGroupAction,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  type WorkLogToolLifecycleStatus,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  resolveT3McpToolPresentation,
  type T3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";
import { truncate } from "@t3tools/shared/String";
import {
  collectToolFilePaths,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";
import type { ThreadFeedActivity } from "./threadActivity";

/** Long Android headers can ANR despite one-line display; cap labels only, preserving expanded and copied text. */
const WORK_LOG_LABEL_MAX_LENGTH = 200;

export function compactWorkEntryText(value: string): string {
  return truncate(value.replace(/\s+/gu, " "), WORK_LOG_LABEL_MAX_LENGTH);
}

export function workEntryRowLabel(entry: WorkLogPresentationEntry, expanded = false): string {
  if (entry.itemType === "fork") return entry.label;
  if (expanded && entry.itemType === "reasoning")
    return entry.toolLifecycleStatus === "inProgress" ? "Thinking" : "Thought";
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation) return presentation.displayName;
  if (entry.command?.trim()) return compactWorkEntryText(commandDisplayText(entry.command));
  const action = toolGroupAction(entry);
  const isToolRead = action === "read" && entry.itemType === "dynamic_tool";
  if (action === "code-search" || action === "search") {
    const toolData =
      entry.toolData !== null &&
      typeof entry.toolData === "object" &&
      !Array.isArray(entry.toolData)
        ? (entry.toolData as Record<string, unknown>)
        : undefined;
    const searchLabel =
      entry.itemType === "file_search" ? entry.label : formatSearchToolLabel(toolData);
    if (searchLabel) return searchLabel;
  }
  if (isToolRead) {
    const [firstPath] = entry.changedFiles ?? collectToolFilePaths(entry.toolData);
    if (firstPath) {
      return formatReadToolLabel(firstPath, Math.max(0, (entry.changedFiles?.length ?? 1) - 1));
    }
    if (!expanded) return "Read file";
  }
  const preview =
    entry.command ??
    (isToolRead || (!expanded && (action === "code-search" || action === "search"))
      ? null
      : entry.detail) ??
    (entry.changedFiles?.length
      ? entry.changedFiles.length === 1
        ? entry.changedFiles[0]!
        : `${entry.changedFiles[0]!} +${entry.changedFiles.length - 1} more`
      : null);
  if (expanded) return preview?.trim() ? truncate(preview, WORK_LOG_LABEL_MAX_LENGTH) : entry.label;
  return preview ? compactWorkEntryText(preview) || entry.label : entry.label;
}

export function itemIsToolLike(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "reasoning" ||
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "file_search" ||
    item.type === "web_search" ||
    item.type === "approval_request" ||
    item.type === "user_input_request" ||
    item.type === "dynamic_tool" ||
    item.type === "subagent"
  );
}

export function itemIsProminent(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "fork" ||
    item.type === "thread_created" ||
    item.type === "system_notice" ||
    item.type === "proposed_plan" ||
    item.type === "secret_request" ||
    item.type === "link_request"
  );
}

export function itemStatus(item: OrchestrationV2TurnItem): ThreadFeedActivity["status"] {
  if (item.type === "notification") return item.outcome === "failed" ? "failure" : null;
  if (item.type === "error") {
    if (item.status === "failed")
      return item.failure.class === "usage_limit" ? "neutral" : "failure";
    return item.status === "completed" ? "success" : "neutral";
  }
  if (!itemIsToolLike(item)) return null;
  if (item.status === "failed") return "failure";
  return item.status === "completed" ? "success" : "neutral";
}

export function itemLifecycleStatus(item: OrchestrationV2TurnItem): WorkLogToolLifecycleStatus {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "idle":
      return "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

export function itemWorkLogTone(item: OrchestrationV2TurnItem): WorkLogPresentationEntry["tone"] {
  if (item.type === "error") return "info";
  if (item.type === "reasoning") return "thinking";
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
      return "tool";
    default:
      return "info";
  }
}

export function itemToolPresentation(item: OrchestrationV2TurnItem): T3McpToolPresentation | null {
  if (item.type !== "dynamic_tool") {
    return null;
  }
  return (
    resolveT3McpToolPresentation(item.toolName, item.input) ??
    resolveT3McpToolPresentation(item.title, item.input)
  );
}

export function itemPreview(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "reasoning":
      return item.text || null;
    case "command_execution":
      return item.input || null;
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? null;
    case "web_search":
      return item.patterns?.join(", ") ?? null;
    case "approval_request":
      return item.prompt ?? null;
    case "user_input_request":
      return item.questions.map((question) => question.question).join(" · ") || null;
    case "checkpoint":
      return item.files.length === 1
        ? (item.files[0]?.path ?? null)
        : `${item.files.length} changed files`;
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message || null;
    case "error":
      return item.failure.message;
    case "compaction":
    case "handoff":
      return item.summary ?? null;
    case "fork":
    case "thread_created":
      return item.targetThreadId;
    case "secret_request":
    case "link_request":
      return item.reason || null;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return null;
    case "notification":
      return item.detail ?? null;
    case "proposed_plan":
      return item.markdown || null;
    case "todo_list":
      return `${item.steps.filter((step) => step.status === "completed").length}/${item.steps.length} completed`;
    case "user_message":
    case "assistant_message":
      return item.text || null;
  }
}

export function formatItemFullDetail(
  row: OrchestrationV2ProjectedTurnItem,
  item: OrchestrationV2TurnItem,
): string {
  return JSON.stringify(
    {
      visibility: row.visibility,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: toolItemForDisplay(item),
    },
    null,
    2,
  );
}

export function singleToolCallLabel(activity: ThreadFeedActivity, expanded: boolean): string {
  if (activity.workEntry.itemType === "reasoning")
    return expanded
      ? "Thought"
      : compactWorkEntryText(activity.workEntry.detail ?? "") || "Thought";
  const presentation = resolveWorkEntryToolPresentation(activity.workEntry, "completed");
  if (presentation) return presentation.displayName;
  const command = activity.workEntry.command?.trim();
  return command ? truncate(command, WORK_LOG_LABEL_MAX_LENGTH) : activity.summary;
}
