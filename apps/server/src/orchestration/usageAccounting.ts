import * as Schema from "effect/Schema";
import { ClaudeModelUsageMap, type UsageTokenCounters } from "@t3tools/contracts";

/**
 * Pure delta accounting for usage facts.
 *
 * Providers report session-cumulative counters (Codex `tokenUsage.total`,
 * Claude `modelUsage`). A usage fact must carry interval counters, so every
 * emission subtracts a baseline: the sum of everything already recorded for
 * that provider-native session and model. Baselines survive restarts by
 * reseeding from `projection_usage_facts` sums.
 */

export interface UsageCumulativeCounters extends UsageTokenCounters {
  readonly costMicroUsd: number;
}

export const ZERO_USAGE_COUNTERS: UsageCumulativeCounters = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  costMicroUsd: 0,
};

export interface UsageDeltaResult {
  readonly delta: UsageCumulativeCounters;
  /** The cumulative counters that become the next baseline. */
  readonly nextBaseline: UsageCumulativeCounters;
  /** True when any counter went backwards (provider session reset); the
   * absolute cumulative value is used as the delta in that case. */
  readonly reset: boolean;
}

function nonNegative(value: number): number {
  return value > 0 ? Math.round(value) : 0;
}

export function usageDelta(
  baseline: UsageCumulativeCounters,
  cumulative: UsageCumulativeCounters,
): UsageDeltaResult {
  const reset =
    cumulative.inputTokens < baseline.inputTokens ||
    cumulative.cachedInputTokens < baseline.cachedInputTokens ||
    cumulative.outputTokens < baseline.outputTokens;

  if (reset) {
    return { delta: cumulative, nextBaseline: cumulative, reset: true };
  }

  return {
    delta: {
      inputTokens: nonNegative(cumulative.inputTokens - baseline.inputTokens),
      cachedInputTokens: nonNegative(cumulative.cachedInputTokens - baseline.cachedInputTokens),
      cacheCreationTokens: nonNegative(
        cumulative.cacheCreationTokens - baseline.cacheCreationTokens,
      ),
      outputTokens: nonNegative(cumulative.outputTokens - baseline.outputTokens),
      reasoningOutputTokens: nonNegative(
        cumulative.reasoningOutputTokens - baseline.reasoningOutputTokens,
      ),
      costMicroUsd: nonNegative(cumulative.costMicroUsd - baseline.costMicroUsd),
    },
    nextBaseline: cumulative,
    reset: false,
  };
}

export function isZeroUsage(counters: UsageCumulativeCounters): boolean {
  return (
    counters.inputTokens === 0 &&
    counters.cachedInputTokens === 0 &&
    counters.cacheCreationTokens === 0 &&
    counters.outputTokens === 0 &&
    counters.reasoningOutputTokens === 0 &&
    counters.costMicroUsd === 0
  );
}

/** Strip provider capacity suffixes (`claude-fable-5[1m]` → `claude-fable-5`)
 * while keeping the raw id available for display and pricing overrides. */
export function canonicalModelId(rawModel: string): string {
  return rawModel.replace(/\[[^\]]+\]$/, "");
}

const decodeClaudeModelUsage = Schema.decodeUnknownOption(ClaudeModelUsageMap);

/** Claude's `modelUsage` map is cumulative per SDK session. Returns cumulative
 * counters per raw model id, or undefined when the payload doesn't parse. */
export function claudeCumulativeByModel(
  modelUsage: unknown,
): ReadonlyMap<string, UsageCumulativeCounters> | undefined {
  const decoded = decodeClaudeModelUsage(modelUsage);
  if (decoded._tag === "None") {
    return undefined;
  }
  const result = new Map<string, UsageCumulativeCounters>();
  for (const [rawModel, entry] of Object.entries(decoded.value)) {
    result.set(rawModel, {
      inputTokens: nonNegative(entry.inputTokens),
      cachedInputTokens: nonNegative(entry.cacheReadInputTokens),
      cacheCreationTokens: nonNegative(entry.cacheCreationInputTokens),
      outputTokens: nonNegative(entry.outputTokens),
      reasoningOutputTokens: 0,
      costMicroUsd: entry.costUSD !== undefined ? nonNegative(entry.costUSD * 1_000_000) : 0,
    });
  }
  return result;
}

/** Codex cumulative totals from a ThreadTokenUsageSnapshot's `total*` fields.
 * Codex reports input inclusive of cached reads; the uncached share is the
 * difference. Returns undefined when the snapshot has no cumulative fields
 * (Claude context-window snapshots land here and are settled at turn end). */
export function codexCumulativeFromSnapshot(usage: {
  readonly totalInputTokens?: number | undefined;
  readonly totalCachedInputTokens?: number | undefined;
  readonly totalOutputTokens?: number | undefined;
  readonly totalReasoningOutputTokens?: number | undefined;
}): UsageCumulativeCounters | undefined {
  if (usage.totalInputTokens === undefined && usage.totalOutputTokens === undefined) {
    return undefined;
  }
  const totalInput = usage.totalInputTokens ?? 0;
  const cached = usage.totalCachedInputTokens ?? 0;
  return {
    inputTokens: nonNegative(totalInput - cached),
    cachedInputTokens: nonNegative(cached),
    cacheCreationTokens: 0,
    outputTokens: nonNegative(usage.totalOutputTokens ?? 0),
    reasoningOutputTokens: nonNegative(usage.totalReasoningOutputTokens ?? 0),
    costMicroUsd: 0,
  };
}
