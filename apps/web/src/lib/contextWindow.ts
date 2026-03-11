import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface ContextWindowStatus {
  remainingRatio: number;
  remainingTokens: number;
  usedTokens: number;
  totalTokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function readNumericField(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): number | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = asNonNegativeNumber(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function unwrapUsage(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (!direct) {
    return null;
  }
  const usage =
    asRecord(direct.usage) ??
    asRecord(direct.tokenUsage) ??
    asRecord(direct.token_usage) ??
    asRecord(direct.info);
  return usage ?? direct;
}

function findContextWindowLimit(usage: Record<string, unknown> | null): number | null {
  return (
    readNumericField(usage, [
      "model_context_window",
      "modelContextWindow",
      "context_window",
      "contextWindow",
      "max_input_tokens",
      "maxInputTokens",
    ]) ??
    readNumericField(asRecord(usage?.limits), [
      "model_context_window",
      "modelContextWindow",
      "context_window",
      "contextWindow",
      "max_input_tokens",
      "maxInputTokens",
    ])
  );
}

function findRemainingTokens(
  usage: Record<string, unknown> | null,
  contextWindowLimit: number,
): number | null {
  const directRemaining =
    readNumericField(usage, [
      "remaining_context_tokens",
      "remainingContextTokens",
      "remaining_tokens",
      "remainingTokens",
      "context_left_tokens",
      "contextLeftTokens",
    ]) ??
    readNumericField(asRecord(usage?.limits), [
      "remaining_context_tokens",
      "remainingContextTokens",
      "remaining_tokens",
      "remainingTokens",
      "context_left_tokens",
      "contextLeftTokens",
    ]);
  if (directRemaining !== null) {
    return Math.min(directRemaining, contextWindowLimit);
  }

  const directRemainingRatio =
    readNumericField(usage, [
      "remaining_context_fraction",
      "remainingContextFraction",
      "remaining_context_ratio",
      "remainingContextRatio",
    ]) ??
    readNumericField(asRecord(usage?.limits), [
      "remaining_context_fraction",
      "remainingContextFraction",
      "remaining_context_ratio",
      "remainingContextRatio",
    ]);
  if (directRemainingRatio !== null && directRemainingRatio <= 1) {
    return Math.round(contextWindowLimit * directRemainingRatio);
  }

  const directRemainingPercent =
    readNumericField(usage, [
      "remaining_context_percent",
      "remainingContextPercent",
      "context_left_percent",
      "contextLeftPercent",
    ]) ??
    readNumericField(asRecord(usage?.limits), [
      "remaining_context_percent",
      "remainingContextPercent",
      "context_left_percent",
      "contextLeftPercent",
    ]);
  if (directRemainingPercent !== null && directRemainingPercent <= 100) {
    return Math.round(contextWindowLimit * (directRemainingPercent / 100));
  }

  return null;
}

function findUsedContextTokens(
  usage: Record<string, unknown> | null,
  contextWindowLimit: number,
): number | null {
  const candidates = [
    readNumericField(asRecord(usage?.current_token_usage), [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "promptTokens",
      "context_tokens",
      "contextTokens",
      "total_tokens",
      "totalTokens",
    ]),
    readNumericField(asRecord(usage?.last_token_usage), [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "promptTokens",
      "context_tokens",
      "contextTokens",
      "total_tokens",
      "totalTokens",
    ]),
    readNumericField(usage, [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "promptTokens",
      "context_tokens",
      "contextTokens",
      "total_tokens",
      "totalTokens",
    ]),
    readNumericField(asRecord(usage?.total_token_usage), [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "promptTokens",
      "context_tokens",
      "contextTokens",
      "total_tokens",
      "totalTokens",
    ]),
  ];

  for (const candidate of candidates) {
    if (candidate !== null && candidate <= contextWindowLimit) {
      return candidate;
    }
  }

  return null;
}

export function deriveContextWindowStatusFromUsage(
  usageValue: unknown,
): ContextWindowStatus | null {
  const usage = unwrapUsage(usageValue);
  const totalTokens = findContextWindowLimit(usage);
  if (totalTokens === null || totalTokens <= 0) {
    return null;
  }

  const remainingTokensFromPayload = findRemainingTokens(usage, totalTokens);
  if (remainingTokensFromPayload !== null) {
    const remainingTokens = Math.max(0, Math.min(totalTokens, remainingTokensFromPayload));
    return {
      remainingRatio: remainingTokens / totalTokens,
      remainingTokens,
      usedTokens: totalTokens - remainingTokens,
      totalTokens,
    };
  }

  const usedTokens = findUsedContextTokens(usage, totalTokens);
  if (usedTokens === null) {
    return null;
  }

  const remainingTokens = Math.max(0, totalTokens - usedTokens);
  return {
    remainingRatio: remainingTokens / totalTokens,
    remainingTokens,
    usedTokens,
    totalTokens,
  };
}

export function deriveLatestContextWindowStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowStatus | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "thread.token-usage.updated") {
      continue;
    }
    const status = deriveContextWindowStatusFromUsage(activity.payload);
    if (status) {
      return status;
    }
  }

  return null;
}
