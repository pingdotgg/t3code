import type { TurnTokenUsage } from "@t3tools/contracts";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

type CodexCumulativeTokenUsage = {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens?: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
};

interface CodexTurnTokenUsageAccumulator {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number | undefined;
  outputTokens: number;
  reasoningTokens: number;
  observed: boolean;
  hasSubagents: boolean;
}

export interface CodexTurnTokenUsageState {
  baseline: CodexCumulativeTokenUsage | undefined;
  activeTurnId: string | undefined;
  readonly byTurnId: Map<string, CodexTurnTokenUsageAccumulator>;
}

function codexTokenUsageBreakdown(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification__TokenUsageBreakdown,
): CodexCumulativeTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cacheCreationTokens: usage.cacheWriteInputTokens }
      : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
  };
}

export function makeCodexTurnTokenUsageState(): CodexTurnTokenUsageState {
  return {
    baseline: undefined,
    activeTurnId: undefined,
    byTurnId: new Map(),
  };
}

export function getCodexTurnAccumulator(
  state: CodexTurnTokenUsageState,
  turnId: string,
): CodexTurnTokenUsageAccumulator {
  const existing = state.byTurnId.get(turnId);
  if (existing) return existing;
  const created: CodexTurnTokenUsageAccumulator = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    observed: false,
    hasSubagents: false,
  };
  state.byTurnId.set(turnId, created);
  return created;
}

/**
 * Usage added by one `thread/tokenUsage/updated` notification. Codex reports a
 * running `total` for the thread and `last`, the usage of the newest model
 * response. Within a turn the growth of `total` equals `last`. Without a prior
 * total (first update after resume or rollback), or when Codex reset the
 * running total, `last` is the delta.
 */
function codexTurnTokenUsageDelta(
  previous: CodexCumulativeTokenUsage | undefined,
  current: CodexCumulativeTokenUsage,
  last: CodexCumulativeTokenUsage,
): CodexCumulativeTokenUsage {
  if (
    previous === undefined ||
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens
  ) {
    return last;
  }
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    ...(current.cacheCreationTokens !== undefined &&
    previous.cacheCreationTokens !== undefined &&
    current.cacheCreationTokens >= previous.cacheCreationTokens
      ? { cacheCreationTokens: current.cacheCreationTokens - previous.cacheCreationTokens }
      : {}),
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
  };
}

export function accumulateCodexTurnTokenUsage(
  state: CodexTurnTokenUsageState,
  turnId: string,
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): void {
  const current = codexTokenUsageBreakdown(usage.total);
  if (state.activeTurnId !== turnId) {
    // The total is thread-wide, so every update moves the baseline. A late
    // update for a finished turn is not counted toward the live turn.
    state.baseline = current;
    return;
  }

  const accumulator = getCodexTurnAccumulator(state, turnId);
  const delta = codexTurnTokenUsageDelta(
    state.baseline,
    current,
    codexTokenUsageBreakdown(usage.last),
  );
  state.baseline = current;

  if (
    delta.inputTokens > 0 ||
    delta.cachedInputTokens > 0 ||
    delta.outputTokens > 0 ||
    delta.reasoningTokens > 0
  ) {
    accumulator.observed = true;
  }
  accumulator.inputTokens += delta.inputTokens;
  accumulator.cachedInputTokens += delta.cachedInputTokens;
  accumulator.outputTokens += delta.outputTokens;
  accumulator.reasoningTokens += delta.reasoningTokens;
  if (delta.cacheCreationTokens === undefined) {
    accumulator.cacheCreationTokens = undefined;
  } else if (accumulator.cacheCreationTokens !== undefined) {
    accumulator.cacheCreationTokens += delta.cacheCreationTokens;
  }
}

export function completeCodexTurnTokenUsage(
  state: CodexTurnTokenUsageState,
  turnId: string,
  completed: boolean,
): TurnTokenUsage {
  const usage = state.byTurnId.get(turnId);
  state.byTurnId.delete(turnId);
  if (state.activeTurnId === turnId) state.activeTurnId = undefined;
  if (!usage) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: false,
    };
  }

  if (!usage.observed) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: usage.hasSubagents,
    };
  }

  // Codex counts cache reads and writes inside inputTokens. Clamp the
  // subsets so the record keeps the documented relationships even if a
  // counter drifts.
  return {
    usageStatus: completed ? "complete" : "partial",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    cachedInputTokens: Math.min(usage.inputTokens, usage.cachedInputTokens),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: Math.min(usage.inputTokens, usage.cacheCreationTokens) }
      : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
    hasSubagents: usage.hasSubagents,
  };
}
