import type {
  ModelSelection,
  OrchestrationThreadActivity,
  ServerProvider,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Context-window options are provider-defined strings (Devin uses values such
 * as `200k` and `1m`). Parse the common forms so the meter reflects the active
 * option rather than always using the model's largest advertised limit.
 */
function parseContextWindowOption(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)\s*(k|m)?$/iu.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1_000 : 1;
  const tokens = Math.round(amount * multiplier);
  return tokens > 0 ? tokens : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "devin":
      return "Devin";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      model: typeof payload?.model === "string" ? payload.model : null,
      providerSessionId:
        typeof payload?.providerSessionId === "string" ? payload.providerSessionId : null,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      cacheCreationTokens: asFiniteNumber(payload?.cacheCreationTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastCacheCreationTokens: asFiniteNumber(payload?.lastCacheCreationTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      autoCompactThreshold: asFiniteNumber(payload?.autoCompactThreshold),
      lastCostUsd: asFiniteNumber(payload?.lastCostUsd),
      sessionCostUsd: asFiniteNumber(payload?.sessionCostUsd),
      costCurrency: typeof payload?.costCurrency === "string" ? payload.costCurrency : null,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

/**
 * Build a zero-usage context snapshot from provider catalog metadata.
 *
 * ACP providers are allowed to omit usage notifications until the first turn
 * (and some older Devin CLI builds never send a usage update at all). Keeping
 * the known model limit visible avoids hiding the context control merely
 * because no token event has arrived yet. A real `context-window.updated`
 * activity always takes precedence in the caller.
 */
export function deriveKnownContextWindowSnapshot(input: {
  readonly selection: ModelSelection | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly updatedAt: string;
}): ContextWindowSnapshot | null {
  const selection = input.selection;
  if (!selection) return null;

  const provider = input.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  const selectedContextWindow = selection.options?.find(
    (option) => option.id === "contextWindow",
  )?.value;
  const maxTokens = parseContextWindowOption(selectedContextWindow) ?? model?.contextWindowTokens;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return null;
  }

  return {
    usedTokens: 0,
    totalProcessedTokens: 0,
    maxTokens,
    model: selection.model,
    providerSessionId: null,
    remainingTokens: maxTokens,
    usedPercentage: 0,
    remainingPercentage: 100,
    inputTokens: null,
    cachedInputTokens: null,
    cacheCreationTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastCacheCreationTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    autoCompactThreshold: null,
    lastCostUsd: null,
    sessionCostUsd: null,
    costCurrency: null,
    updatedAt: input.updatedAt,
  };
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
