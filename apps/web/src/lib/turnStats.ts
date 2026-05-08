import type {
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import type { ChatMessage } from "../types";
import {
  deriveLatestContextWindowSnapshotForTurn,
  deriveLatestUnassignedContextWindowSnapshotSince,
  type ContextWindowSnapshot,
} from "./contextWindow";

export interface AssistantTurnStatItem {
  readonly id: string;
  readonly label: string;
  readonly tooltip?: string | undefined;
}

export interface AssistantTurnStats {
  readonly summaryLabel: string;
  readonly items: ReadonlyArray<AssistantTurnStatItem>;
}

type CompletedTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toPositiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function countSingularPlural(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function formatDurationSeconds(value: number): string {
  const totalSeconds = Math.round(value);
  if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const minuteLabel = `${minutes.toLocaleString()} min`;
    return seconds > 0 ? `${minuteLabel} ${seconds.toLocaleString()} sec` : minuteLabel;
  }
  if (value >= 10) {
    return `${totalSeconds} sec`;
  }
  return `${value.toFixed(1).replace(/\.0$/, "")} sec`;
}

function formatTokensPerSecond(value: number): string {
  if (value >= 100) {
    return `${Math.round(value).toLocaleString()} tok/sec`;
  }
  if (value >= 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")} tok/sec`;
  }
  return `${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} tok/sec`;
}

function formatEffortLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const compact = value.replace(/[_-]+/g, " ").trim();
  if (!compact) {
    return null;
  }
  if (/^x?high$/i.test(compact)) {
    return compact.length === 5 ? "XHigh" : "High";
  }
  return compact
    .split(/\s+/)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

function formatModelLabel(modelSelection: ModelSelection | null | undefined): string | null {
  const model = asTrimmedString(modelSelection?.model);
  if (!model) {
    return null;
  }
  const effort = formatEffortLabel(
    getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      getModelSelectionStringOptionValue(modelSelection, "effort") ??
      null,
  );
  return effort ? `${model} (${effort})` : model;
}

function deriveElapsedMs(latestTurn: CompletedTurn): number | null {
  if (!latestTurn.startedAt || !latestTurn.completedAt) {
    return null;
  }
  const startedAt = Date.parse(latestTurn.startedAt);
  const completedAt = Date.parse(latestTurn.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt <= startedAt) {
    return null;
  }
  return completedAt - startedAt;
}

function deriveDisplayTokenCount(snapshot: ContextWindowSnapshot | null): number | null {
  if (!snapshot) {
    return null;
  }
  return (
    toPositiveFiniteNumber(snapshot.lastOutputTokens) ??
    toPositiveFiniteNumber(snapshot.lastUsedTokens) ??
    toPositiveFiniteNumber(snapshot.totalProcessedTokens)
  );
}

function extractToolIdentity(
  activity: OrchestrationThreadActivity,
  options?: { includeDisplayFallback?: boolean },
): string | null {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  return (
    asTrimmedString(data?.toolCallId) ??
    asTrimmedString(payload?.itemId) ??
    asTrimmedString(data?.itemId) ??
    (options?.includeDisplayFallback
      ? (asTrimmedString(payload?.title) ?? asTrimmedString(activity.summary))
      : null) ??
    null
  );
}

function countToolCalls(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: OrchestrationThreadActivity["turnId"],
  snapshot: ContextWindowSnapshot | null,
): number | null {
  const relevant = activities.filter((activity) => activity.turnId === turnId);
  const startedKeys = new Set<string>();
  for (const activity of relevant) {
    if (activity.kind !== "tool.started") {
      continue;
    }
    const key = extractToolIdentity(activity);
    startedKeys.add(key ?? activity.id);
  }
  if (startedKeys.size > 0) {
    return startedKeys.size;
  }

  const lifecycleKeys = new Set<string>();
  for (const activity of relevant) {
    if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
      continue;
    }
    const key = extractToolIdentity(activity);
    lifecycleKeys.add(key ?? activity.id);
  }
  if (lifecycleKeys.size > 0) {
    return lifecycleKeys.size;
  }

  const toolUses = toPositiveFiniteNumber(snapshot?.toolUses);
  return toolUses;
}

export function deriveLatestAssistantTurnStats(input: {
  latestTurn: CompletedTurn | null;
  assistantMessage: ChatMessage | null;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  modelSelection: ModelSelection | null | undefined;
}): AssistantTurnStats | null {
  const { latestTurn, assistantMessage, activities, modelSelection } = input;
  if (
    !latestTurn ||
    latestTurn.state !== "completed" ||
    !latestTurn.turnId ||
    !assistantMessage ||
    assistantMessage.role !== "assistant" ||
    assistantMessage.streaming ||
    assistantMessage.turnId !== latestTurn.turnId
  ) {
    return null;
  }

  const snapshot =
    deriveLatestContextWindowSnapshotForTurn(activities, latestTurn.turnId) ??
    deriveLatestUnassignedContextWindowSnapshotSince(activities, latestTurn.startedAt);
  const items: AssistantTurnStatItem[] = [];

  const modelLabel = formatModelLabel(modelSelection);
  if (modelLabel) {
    items.push({ id: "model", label: modelLabel });
  }

  const elapsedMs = deriveElapsedMs(latestTurn);
  if (elapsedMs !== null) {
    items.push({
      id: "elapsed",
      label: formatDurationSeconds(elapsedMs / 1_000),
    });
  }

  const tokenCount = deriveDisplayTokenCount(snapshot);
  if (tokenCount !== null) {
    items.push({
      id: "tokens",
      label: countSingularPlural(tokenCount, "token"),
    });
  }

  const throughputDurationMs = toPositiveFiniteNumber(snapshot?.durationMs);
  if (tokenCount !== null && throughputDurationMs !== null) {
    const tokensPerSecond = tokenCount / (throughputDurationMs / 1_000);
    if (Number.isFinite(tokensPerSecond) && tokensPerSecond > 0) {
      items.push({
        id: "throughput",
        label: formatTokensPerSecond(tokensPerSecond),
        tooltip: "Approximate throughput based on provider token counts and generation duration.",
      });
    }
  }

  const timeToFirstTokenMs = toPositiveFiniteNumber(snapshot?.timeToFirstTokenMs);
  if (timeToFirstTokenMs !== null) {
    items.push({
      id: "ttft",
      label: `Time-to-first: ${formatDurationSeconds(timeToFirstTokenMs / 1_000)}`,
      tooltip: "Approximate time-to-first based on first assistant output timing.",
    });
  }

  const toolCalls = countToolCalls(activities, latestTurn.turnId, snapshot);
  if (toolCalls !== null && toolCalls > 0) {
    items.push({
      id: "tools",
      label: countSingularPlural(toolCalls, "tool call"),
    });
  }

  if (items.length === 0) {
    return null;
  }

  return {
    summaryLabel: items.map((item) => item.label).join(". "),
    items,
  };
}

export function buildLatestAssistantTurnStatsMap(input: {
  latestTurn: CompletedTurn | null;
  assistantMessage: ChatMessage | null;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  modelSelection: ModelSelection | null | undefined;
}): ReadonlyMap<ChatMessage["id"], AssistantTurnStats> {
  const stats = deriveLatestAssistantTurnStats(input);
  if (!stats || !input.assistantMessage) {
    return new Map();
  }
  return new Map([[input.assistantMessage.id, stats]]);
}
