import {
  SubagentActivationId,
  type NodeId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentActivity,
  type OrchestrationV2SubagentRole,
  type OrchestrationV2SubagentUsage,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

export const SUBAGENT_RECENT_ACTIVITY_LIMIT = 6;
const SUBAGENT_ACTIVITY_TEXT_LIMIT = 180;

export const defaultSubagentRole = (name = "general-purpose"): OrchestrationV2SubagentRole => ({
  name,
  source: "app_default",
});

export const providerSubagentRole = (
  name: string | null | undefined,
  fallback = "general-purpose",
): OrchestrationV2SubagentRole => {
  const normalized = name?.trim();
  return normalized ? { name: normalized, source: "provider" } : defaultSubagentRole(fallback);
};

export const subagentActivationId = (subagentId: NodeId, ordinal: number) =>
  SubagentActivationId.make(`${subagentId}:activation:${ordinal}`);

const boundedActivityText = (value: string) => {
  const normalized = value.trim();
  return normalized.length > SUBAGENT_ACTIVITY_TEXT_LIMIT
    ? `${normalized.slice(0, SUBAGENT_ACTIVITY_TEXT_LIMIT - 1)}…`
    : normalized;
};

export const appendSubagentActivity = (
  current: OrchestrationV2Subagent["recentActivity"],
  summary: string | null | undefined,
  at: DateTime.Utc,
): ReadonlyArray<OrchestrationV2SubagentActivity> => {
  if (!summary?.trim()) return current;
  const bounded = boundedActivityText(summary);
  if (current.at(-1)?.summary === bounded) return current;
  return [...current, { at, summary: bounded }].slice(-SUBAGENT_RECENT_ACTIVITY_LIMIT);
};

const cumulative = (previous: number | undefined, next: number | undefined) =>
  next === undefined ? previous : Math.max(previous ?? 0, next);

// Provider progress frames are cumulative snapshots within one scope, not
// deltas. Taking the maximum makes duplicate and late out-of-order frames
// idempotent without inventing usage the provider did not report.
export const mergeCumulativeSubagentUsage = (
  previous: OrchestrationV2SubagentUsage | null,
  next: OrchestrationV2SubagentUsage | null | undefined,
): OrchestrationV2SubagentUsage | null => {
  if (next === undefined || next === null) return previous;
  return {
    totalTokens: Math.max(previous?.totalTokens ?? 0, next.totalTokens),
    ...(cumulative(previous?.inputTokens, next.inputTokens) === undefined
      ? {}
      : { inputTokens: cumulative(previous?.inputTokens, next.inputTokens) }),
    ...(cumulative(previous?.cachedInputTokens, next.cachedInputTokens) === undefined
      ? {}
      : { cachedInputTokens: cumulative(previous?.cachedInputTokens, next.cachedInputTokens) }),
    ...(cumulative(previous?.outputTokens, next.outputTokens) === undefined
      ? {}
      : { outputTokens: cumulative(previous?.outputTokens, next.outputTokens) }),
    ...(cumulative(previous?.reasoningOutputTokens, next.reasoningOutputTokens) === undefined
      ? {}
      : {
          reasoningOutputTokens: cumulative(
            previous?.reasoningOutputTokens,
            next.reasoningOutputTokens,
          ),
        }),
    ...(cumulative(previous?.toolUses, next.toolUses) === undefined
      ? {}
      : { toolUses: cumulative(previous?.toolUses, next.toolUses) }),
    ...(cumulative(previous?.durationMs, next.durationMs) === undefined
      ? {}
      : { durationMs: cumulative(previous?.durationMs, next.durationMs) }),
  };
};

const accumulated = (
  previous: number | undefined,
  previousActivation: number | undefined,
  next: number | undefined,
) =>
  next === undefined ? previous : (previous ?? 0) + Math.max(0, next - (previousActivation ?? 0));

// Lifetime usage advances only by the change since the prior snapshot for the
// current activation. Pass no prior activation snapshot when a new activation
// starts so its first cumulative snapshot is added in full.
export const accumulateCumulativeSubagentUsage = (
  previous: OrchestrationV2SubagentUsage | null,
  previousActivation: OrchestrationV2SubagentUsage | null | undefined,
  next: OrchestrationV2SubagentUsage | null | undefined,
): OrchestrationV2SubagentUsage | null => {
  if (next === undefined || next === null) return previous;
  return {
    totalTokens:
      (previous?.totalTokens ?? 0) +
      Math.max(0, next.totalTokens - (previousActivation?.totalTokens ?? 0)),
    ...(accumulated(previous?.inputTokens, previousActivation?.inputTokens, next.inputTokens) ===
    undefined
      ? {}
      : {
          inputTokens: accumulated(
            previous?.inputTokens,
            previousActivation?.inputTokens,
            next.inputTokens,
          ),
        }),
    ...(accumulated(
      previous?.cachedInputTokens,
      previousActivation?.cachedInputTokens,
      next.cachedInputTokens,
    ) === undefined
      ? {}
      : {
          cachedInputTokens: accumulated(
            previous?.cachedInputTokens,
            previousActivation?.cachedInputTokens,
            next.cachedInputTokens,
          ),
        }),
    ...(accumulated(previous?.outputTokens, previousActivation?.outputTokens, next.outputTokens) ===
    undefined
      ? {}
      : {
          outputTokens: accumulated(
            previous?.outputTokens,
            previousActivation?.outputTokens,
            next.outputTokens,
          ),
        }),
    ...(accumulated(
      previous?.reasoningOutputTokens,
      previousActivation?.reasoningOutputTokens,
      next.reasoningOutputTokens,
    ) === undefined
      ? {}
      : {
          reasoningOutputTokens: accumulated(
            previous?.reasoningOutputTokens,
            previousActivation?.reasoningOutputTokens,
            next.reasoningOutputTokens,
          ),
        }),
    ...(accumulated(previous?.toolUses, previousActivation?.toolUses, next.toolUses) === undefined
      ? {}
      : {
          toolUses: accumulated(previous?.toolUses, previousActivation?.toolUses, next.toolUses),
        }),
    ...(accumulated(previous?.durationMs, previousActivation?.durationMs, next.durationMs) ===
    undefined
      ? {}
      : {
          durationMs: accumulated(
            previous?.durationMs,
            previousActivation?.durationMs,
            next.durationMs,
          ),
        }),
  };
};
