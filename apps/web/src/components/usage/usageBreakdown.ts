import type { UsageTokenTotals } from "@t3tools/contracts";
import {
  isModelCostUnknown,
  type CategoryCost,
  type ModelTotals,
  type SpeedCost,
} from "@t3tools/shared/usageMerge";

import type { ShareSegment } from "./UsageShareBar";

export function sortModelsByTokens(models: readonly ModelTotals[]) {
  return models.toSorted(
    (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
  );
}

/** Unknown cost yields null cost share; unpriced models still have token shares. */
export function modelShare(model: ModelTotals, metric: "cost" | "tokens"): number | null {
  if (metric === "tokens") return model.tokenShare;
  return isModelCostUnknown(model) ? null : model.costShare;
}

/** Returns null without input; cache writes count as misses because input was fully processed. */
export function cacheHitRate({ tokens }: ModelTotals): number | null {
  const input = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
  return input === 0 ? null : tokens.cachedInputTokens / input;
}

/** Effective USD per million priced tokens, or `null` when none were priced. */
export function costPerMillionTokens(model: ModelTotals): number | null {
  const pricedTokens = model.totalTokens - model.unpricedTokens;
  return pricedTokens <= 0 || isModelCostUnknown(model)
    ? null
    : (model.costUsd / pricedTokens) * 1_000_000;
}

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

const TYPE_COLORS = {
  input: ink(60),
  cacheRead: ink(30),
  cacheWrite: ink(72),
  output: ink(100),
  other: ink(44),
};

export function costTypeSegments(cost: CategoryCost): readonly ShareSegment[] {
  return [
    { label: "misc.usage.type.input", value: cost.input, color: TYPE_COLORS.input },
    { label: "misc.usage.type.cacheRead", value: cost.cacheRead, color: TYPE_COLORS.cacheRead },
    { label: "misc.usage.type.cacheWrite", value: cost.cacheWrite, color: TYPE_COLORS.cacheWrite },
    { label: "misc.usage.type.output", value: cost.output, color: TYPE_COLORS.output },
    {
      label: "misc.usage.type.other",
      value: cost.unsplit >= 0.005 ? cost.unsplit : 0,
      color: TYPE_COLORS.other,
    },
  ];
}

export function tokenTypeSegments(
  tokens: Omit<UsageTokenTotals, "reasoningTokens">,
): readonly ShareSegment[] {
  return [
    { label: "misc.usage.type.input", value: tokens.uncachedInputTokens, color: TYPE_COLORS.input },
    {
      label: "misc.usage.type.cacheRead",
      value: tokens.cachedInputTokens,
      color: TYPE_COLORS.cacheRead,
    },
    {
      label: "misc.usage.type.cacheWrite",
      value: tokens.cacheCreationTokens,
      color: TYPE_COLORS.cacheWrite,
    },
    { label: "misc.usage.type.output", value: tokens.outputTokens, color: TYPE_COLORS.output },
  ];
}

export function speedCostSegments(cost: SpeedCost): readonly ShareSegment[] {
  return [
    { label: "misc.usage.speed.standard", value: cost.standard, color: ink(34) },
    { label: "misc.usage.speed.fast", value: cost.fast, color: ink(66) },
    { label: "misc.usage.speed.ultrafast", value: cost.ultrafast, color: ink(100) },
  ];
}
