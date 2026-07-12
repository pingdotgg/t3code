import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

/**
 * Mobile port of apps/mac/Sources/T3Kit/SubagentTaskActivityState.swift.
 * Folds task.started/task.progress/task.updated/task.completed activities
 * into one row per taskId. Unlike the mac client (which applies events
 * incrementally as they stream in), this recomputes from the full activity
 * list on every call — cheap enough given thread activity counts, and keeps
 * the derivation a pure function like the rest of `threadActivity.ts`.
 */

export type SubagentTaskState = "running" | "paused" | "completed" | "failed" | "stopped";

export interface SubagentTaskProgressEntry {
  readonly at: string;
  readonly toolName: string | null;
  readonly text: string;
}

export interface SubagentTaskItem {
  readonly id: string;
  readonly taskId: string;
  readonly turnId: TurnId | null;
  readonly taskType: string | null;
  readonly description: string | null;
  readonly subagentType: string | null;
  readonly model: string | null;
  readonly workflowName: string | null;
  readonly toolUseId: string | null;
  readonly state: SubagentTaskState;
  readonly latestProgress: string | null;
  readonly lastToolName: string | null;
  readonly usage: unknown;
  readonly isBackgrounded: boolean;
  readonly error: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly lastActivityAt: string;
  readonly completionSummary: string | null;
  readonly progressLog: ReadonlyArray<SubagentTaskProgressEntry>;
}

/** Soft cap on retained progress entries; oldest dropped first. */
export const SUBAGENT_TASK_MAX_PROGRESS_LOG_ENTRIES = 200;
/** Expanded log shows the tail; older entries are summarized above it. */
export const SUBAGENT_TASK_MAX_VISIBLE_LOG_ENTRIES = 30;
/** No progress for this long marks a running task as stalled. */
export const SUBAGENT_TASK_STALLED_THRESHOLD_MS = 3 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function minIso(a: string, b: string): string {
  return Date.parse(b) < Date.parse(a) ? b : a;
}

function maxIso(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started")) return 0;
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) return 1;
  if (kind.endsWith(".completed")) return 2;
  return 1;
}

function compareActivities(a: OrchestrationThreadActivity, b: OrchestrationThreadActivity): number {
  const aSeq = a.sequence ?? Number.MAX_SAFE_INTEGER;
  const bSeq = b.sequence ?? Number.MAX_SAFE_INTEGER;
  if (aSeq !== bSeq) return aSeq - bSeq;
  const aCreatedAt = a.createdAt;
  const bCreatedAt = b.createdAt;
  if (aCreatedAt !== bCreatedAt) return aCreatedAt < bCreatedAt ? -1 : 1;
  const aRank = compareActivityLifecycleRank(a.kind);
  const bRank = compareActivityLifecycleRank(b.kind);
  if (aRank !== bRank) return aRank - bRank;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function progressLine(lastToolName: unknown, summary: unknown): string | null {
  const tool = asTrimmedString(lastToolName);
  if (tool) {
    return `Using ${tool}...`;
  }
  return asTrimmedString(summary);
}

function appendProgress(
  log: ReadonlyArray<SubagentTaskProgressEntry>,
  at: string,
  toolName: string | null,
  text: string | null,
): ReadonlyArray<SubagentTaskProgressEntry> {
  const trimmedText = text?.trim();
  if (!trimmedText) {
    return log;
  }
  const tool = toolName?.trim() || null;
  const last = log.at(-1);
  if (last && last.toolName === tool && last.text === trimmedText) {
    return log;
  }
  const next = [...log, { at, toolName: tool, text: trimmedText }];
  return next.length > SUBAGENT_TASK_MAX_PROGRESS_LOG_ENTRIES
    ? next.slice(next.length - SUBAGENT_TASK_MAX_PROGRESS_LOG_ENTRIES)
    : next;
}

function stateForStatus(status: string | null): SubagentTaskState {
  switch (status) {
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "interrupted":
    case "cancelled":
    case "canceled":
    case "killed":
      return "stopped";
    default:
      return "completed";
  }
}

function isTerminalTaskUpdatedStatus(status: string | null): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

interface FoldState {
  readonly tasksById: Map<string, SubagentTaskItem>;
  readonly order: string[];
  readonly activeTaskIds: Set<string>;
  readonly startedTaskIds: Set<string>;
}

function existingOrNew(
  state: FoldState,
  taskId: string,
  at: string,
  turnId: TurnId | null,
): SubagentTaskItem {
  const existing = state.tasksById.get(taskId);
  if (existing) {
    return existing;
  }
  state.order.push(taskId);
  return {
    id: `subagent-task:${taskId}`,
    taskId,
    turnId,
    taskType: null,
    description: null,
    subagentType: null,
    model: null,
    workflowName: null,
    toolUseId: null,
    state: "running",
    latestProgress: null,
    lastToolName: null,
    usage: undefined,
    isBackgrounded: false,
    error: null,
    startedAt: at,
    completedAt: null,
    lastActivityAt: at,
    completionSummary: null,
    progressLog: [],
  };
}

function store(state: FoldState, item: SubagentTaskItem): void {
  state.tasksById.set(item.taskId, item);
  if (item.state === "running") {
    state.activeTaskIds.add(item.taskId);
  } else {
    state.activeTaskIds.delete(item.taskId);
  }
}

function latestRunningStartedTaskId(state: FoldState): string | null {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const taskId = state.order[index];
    if (
      taskId !== undefined &&
      state.startedTaskIds.has(taskId) &&
      state.activeTaskIds.has(taskId)
    ) {
      return taskId;
    }
  }
  return null;
}

function taskIdFallback(activity: OrchestrationThreadActivity): string | null {
  return activity.kind.startsWith("task.") ? String(activity.id) : null;
}

function applyTaskStarted(
  state: FoldState,
  activity: OrchestrationThreadActivity,
  at: string,
): void {
  const payload = asRecord(activity.payload);
  const taskId = asTrimmedString(payload?.taskId) ?? taskIdFallback(activity);
  if (!taskId) return;
  let item = existingOrNew(state, taskId, at, activity.turnId);
  state.startedTaskIds.add(taskId);
  item = {
    ...item,
    taskType: asTrimmedString(payload?.taskType) ?? item.taskType,
    description:
      asTrimmedString(payload?.description) ?? asTrimmedString(payload?.detail) ?? item.description,
    subagentType: asTrimmedString(payload?.subagentType) ?? item.subagentType,
    model: asTrimmedString(payload?.model) ?? item.model,
    workflowName: asTrimmedString(payload?.workflowName) ?? item.workflowName,
    toolUseId: asTrimmedString(payload?.toolUseId) ?? item.toolUseId,
    startedAt: minIso(item.startedAt, at),
    lastActivityAt: maxIso(item.lastActivityAt, at),
    state: item.completedAt === null ? "running" : item.state,
  };
  store(state, item);
}

function applyTaskProgress(
  state: FoldState,
  activity: OrchestrationThreadActivity,
  at: string,
): void {
  const payload = asRecord(activity.payload);
  const taskId =
    asTrimmedString(payload?.taskId) ??
    latestRunningStartedTaskId(state) ??
    taskIdFallback(activity);
  if (!taskId) return;
  let item = existingOrNew(state, taskId, at, activity.turnId);
  const detailOrSummary = asTrimmedString(payload?.summary) ?? asTrimmedString(payload?.detail);
  item = {
    ...item,
    taskType: asTrimmedString(payload?.taskType) ?? item.taskType,
    description: asTrimmedString(payload?.description) ?? item.description,
    subagentType: asTrimmedString(payload?.subagentType) ?? item.subagentType,
    toolUseId: asTrimmedString(payload?.toolUseId) ?? item.toolUseId,
    lastToolName: asTrimmedString(payload?.lastToolName) ?? item.lastToolName,
    usage:
      payload && "usage" in payload && payload.usage !== undefined ? payload.usage : item.usage,
    latestProgress:
      progressLine(payload?.lastToolName, payload?.summary) ??
      asTrimmedString(payload?.detail) ??
      item.latestProgress,
    lastActivityAt: maxIso(item.lastActivityAt, at),
    state: item.completedAt === null ? "running" : item.state,
  };
  item = {
    ...item,
    progressLog: appendProgress(
      item.progressLog,
      at,
      asTrimmedString(payload?.lastToolName),
      detailOrSummary,
    ),
  };
  store(state, item);
}

function applyTaskUpdated(
  state: FoldState,
  activity: OrchestrationThreadActivity,
  at: string,
): void {
  const payload = asRecord(activity.payload);
  const taskId =
    asTrimmedString(payload?.taskId) ??
    latestRunningStartedTaskId(state) ??
    taskIdFallback(activity);
  if (!taskId) return;
  let item = existingOrNew(state, taskId, at, activity.turnId);
  const isBackgrounded =
    payload && typeof payload.isBackgrounded === "boolean" ? payload.isBackgrounded : null;
  item = {
    ...item,
    description:
      asTrimmedString(payload?.description) ?? asTrimmedString(payload?.detail) ?? item.description,
    model: asTrimmedString(payload?.model) ?? item.model,
    isBackgrounded: isBackgrounded ?? item.isBackgrounded,
    error: asTrimmedString(payload?.error) ?? item.error,
    lastActivityAt: maxIso(item.lastActivityAt, at),
  };

  const status = asTrimmedString(payload?.status);
  if (item.completedAt === null) {
    if (isTerminalTaskUpdatedStatus(status)) {
      const error = asTrimmedString(payload?.error);
      item = {
        ...item,
        completedAt: at,
        state: stateForStatus(status === "killed" ? "stopped" : status),
        ...(error ? { completionSummary: error, latestProgress: error } : {}),
      };
    } else if (status === "paused") {
      item = { ...item, state: "paused" };
    } else {
      item = { ...item, state: "running" };
    }
  } else if (isTerminalTaskUpdatedStatus(status)) {
    const error = asTrimmedString(payload?.error);
    if (error) {
      item = { ...item, error, completionSummary: item.completionSummary ?? error };
    }
  }
  store(state, item);
}

function applyTaskCompleted(
  state: FoldState,
  activity: OrchestrationThreadActivity,
  at: string,
): void {
  const payload = asRecord(activity.payload);
  const taskId =
    asTrimmedString(payload?.taskId) ??
    latestRunningStartedTaskId(state) ??
    taskIdFallback(activity);
  if (!taskId) return;
  let item = existingOrNew(state, taskId, at, activity.turnId);
  const completionSummary =
    asTrimmedString(payload?.summary) ?? asTrimmedString(payload?.detail) ?? item.completionSummary;
  item = {
    ...item,
    taskType: asTrimmedString(payload?.taskType) ?? item.taskType,
    description: asTrimmedString(payload?.description) ?? item.description,
    lastToolName: asTrimmedString(payload?.lastToolName) ?? item.lastToolName,
    usage:
      payload && "usage" in payload && payload.usage !== undefined ? payload.usage : item.usage,
    completionSummary,
    latestProgress: completionSummary ?? item.latestProgress,
  };
  const lastLogText = item.progressLog.at(-1)?.text ?? null;
  if (completionSummary !== null && completionSummary !== lastLogText) {
    item = {
      ...item,
      progressLog: appendProgress(
        item.progressLog,
        at,
        asTrimmedString(payload?.lastToolName),
        completionSummary,
      ),
    };
  }
  item = {
    ...item,
    completedAt: at,
    lastActivityAt: maxIso(item.lastActivityAt, at),
    state: stateForStatus(asTrimmedString(payload?.status)),
  };
  store(state, item);
}

export function deriveSubagentTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<SubagentTaskItem> {
  const state: FoldState = {
    tasksById: new Map(),
    order: [],
    activeTaskIds: new Set(),
    startedTaskIds: new Set(),
  };
  const sorted = [...activities].sort(compareActivities);
  for (const activity of sorted) {
    switch (activity.kind) {
      case "task.started":
        applyTaskStarted(state, activity, activity.createdAt);
        break;
      case "task.progress":
        applyTaskProgress(state, activity, activity.createdAt);
        break;
      case "task.updated":
        applyTaskUpdated(state, activity, activity.createdAt);
        break;
      case "task.completed":
        applyTaskCompleted(state, activity, activity.createdAt);
        break;
      default:
        break;
    }
  }
  const items: SubagentTaskItem[] = [];
  for (const taskId of state.order) {
    const item = state.tasksById.get(taskId);
    if (item) items.push(item);
  }
  return items;
}

export function subagentTaskDurationMs(task: SubagentTaskItem): number | null {
  if (!task.completedAt) return null;
  return Math.max(0, Date.parse(task.completedAt) - Date.parse(task.startedAt));
}

export function subagentTaskTitle(task: SubagentTaskItem): string {
  const trimmed = task.description?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Subagent task";
}

function shortModelName(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("claude-") ? trimmed.slice("claude-".length) : trimmed;
}

/** Compact identity badge: "Explore · sonnet-5" or "workflow · opus-4.8". */
export function subagentTaskIdentityBadge(
  task: SubagentTaskItem,
  modelDisplayNames?: ReadonlyMap<string, string>,
): string | null {
  const parts: string[] = [];
  if (task.workflowName) {
    parts.push(task.workflowName);
  } else if (task.subagentType) {
    parts.push(task.subagentType);
  } else if (task.taskType) {
    parts.push(task.taskType.replaceAll("-", " "));
  }
  if (task.model) {
    const displayName = modelDisplayNames?.get(task.model.trim())?.trim();
    parts.push(displayName || shortModelName(task.model));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function subagentTaskSubtitle(task: SubagentTaskItem): string | null {
  if (task.state !== "running") {
    const progress = task.latestProgress?.trim();
    if (progress) {
      return progress;
    }
    switch (task.state) {
      case "paused":
        return "Paused";
      case "completed":
        return "Completed";
      case "failed":
        return "Failed";
      case "stopped":
        return "Stopped";
      default:
        return null;
    }
  }

  const last = task.progressLog.at(-1);
  if (last) {
    const tool = last.toolName?.trim();
    return tool ? `${tool} · ${last.text}` : last.text;
  }
  const progress = task.latestProgress?.trim();
  return progress && progress.length > 0 ? progress : "Working...";
}

export function subagentTaskLastActivityLabel(task: SubagentTaskItem, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(task.lastActivityAt)) / 1000));
  if (seconds < 5) return "last activity just now";
  if (seconds < 60) return `last activity ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `last activity ${minutes}m ago`;
  return `last activity ${Math.floor(minutes / 60)}h ago`;
}

export function isSubagentTaskStalled(task: SubagentTaskItem, nowMs: number): boolean {
  if (task.state !== "running") return false;
  return nowMs - Date.parse(task.lastActivityAt) > SUBAGENT_TASK_STALLED_THRESHOLD_MS;
}

export function subagentTaskUsageSummary(usage: unknown): string | null {
  const record = asRecord(usage);
  if (!record) return null;
  const parts: string[] = [];
  const total = asInt(record.total_tokens) ?? asInt(record.totalTokens);
  if (total !== null) {
    parts.push(`${total} tokens`);
  } else {
    const input = asInt(record.input_tokens) ?? asInt(record.inputTokens);
    const output = asInt(record.output_tokens) ?? asInt(record.outputTokens);
    if (input !== null) parts.push(`${input} in`);
    if (output !== null) parts.push(`${output} out`);
  }
  const tools = asInt(record.tool_uses) ?? asInt(record.toolUses);
  if (tools !== null) parts.push(`${tools} tools`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function hasSubagentTaskExpandableContent(task: SubagentTaskItem): boolean {
  return (
    task.progressLog.length > 0 ||
    task.error !== null ||
    task.lastToolName !== null ||
    subagentTaskUsageSummary(task.usage) !== null
  );
}
