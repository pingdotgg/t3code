import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { extractNormalizedChangedFilePathsFromToolPayload } from "@t3tools/shared/toolChangedFiles";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function projectCommandData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) return undefined;

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) projectedItem.command = item.command;

  const input = asRecord(item.input);
  if (input && "command" in input) projectedItem.input = { command: input.command };

  const result = asRecord(item.result);
  if (result && "command" in result) projectedItem.result = { command: result.command };

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

function summarizeToolTextOutput(value: string): string | null {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return firstLine.length <= 84 ? firstLine : `${firstLine.slice(0, 83).trimEnd()}…`;
  }
  return lines.length > 1 ? `${lines.length.toLocaleString()} lines` : null;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const rawOutput = asRecord(value);
  if (!rawOutput) return undefined;

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }

  for (const value of [rawOutput.content, rawOutput.stdout]) {
    const text = asTrimmedString(value);
    if (!text) continue;
    const summary = summarizeToolTextOutput(text);
    if (summary) return { content: summary };
  }
  return undefined;
}

export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data || payload.itemType === "mcp_tool_call") {
    return activity;
  }

  const projectedData: Record<string, unknown> = {};
  const item = projectCommandData(data);
  if (item) projectedData.item = item;

  for (const key of ["command", "toolCallId", "kind", "agentRunId", "itemId"] as const) {
    if (key in data) projectedData[key] = data[key];
  }

  const files = extractNormalizedChangedFilePathsFromToolPayload(data);
  if (files.length > 0) {
    projectedData.files = files.map((path) => ({ path }));
  }

  const rawOutput = projectRawOutput(data.rawOutput);
  if (rawOutput) projectedData.rawOutput = rawOutput;

  return {
    ...activity,
    payload: {
      ...payload,
      data: projectedData,
    },
  };
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: snapshot.thread.activities.map(projectActivityPayload),
      ...(snapshot.thread.activityContext
        ? { activityContext: snapshot.thread.activityContext.map(projectActivityPayload) }
        : {}),
    },
  };
}

export function projectReadModel(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      activities: thread.activities.map(projectActivityPayload),
      ...(thread.activityContext
        ? { activityContext: thread.activityContext.map(projectActivityPayload) }
        : {}),
    })),
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") return event;
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
