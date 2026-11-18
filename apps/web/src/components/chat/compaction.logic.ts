import type {
  ContextBreakdownKind,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { msg } from "gt-react";

import { getActiveLocale, m, type MessageResolver } from "../../i18n/messages";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";

function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
  );
}

export function formatContextWindowCompactionMessage(
  autoCompactThreshold?: number | null,
  resolve: MessageResolver = m,
  locale: string = getActiveLocale(),
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return resolve(
      msg("Compacts automatically at about {tokens} tokens.", {
        tokens: autoCompactThreshold.toLocaleString(locale),
      }),
    );
  }
  return resolve(msg("Context compacts automatically when needed."));
}

const CONTEXT_BREAKDOWN_LABELS: Record<ContextBreakdownKind, string> = {
  system_prompt: msg("System prompt"),
  system_tools: msg("System tools"),
  mcp_tools: msg("MCP tools"),
  t3_tools: msg("T3 Code tools"),
  memory_files: msg("Memory files"),
  skills: msg("Skills"),
  custom_agents: msg("Custom agents"),
  messages: msg("Messages", { $context: "context window category: conversation messages" }),
  other: msg("Other", { $context: "context window category" }),
};

// Rows sort largest first, so the bar steps from dark to light. The lightest stays above the track.
const CONTEXT_BREAKDOWN_COLORS = [
  "bg-black/80 dark:bg-white/80",
  "bg-black/64 dark:bg-white/64",
  "bg-black/50 dark:bg-white/50",
  "bg-black/40 dark:bg-white/40",
  "bg-black/32 dark:bg-white/32",
  "bg-black/26 dark:bg-white/26",
  "bg-black/20 dark:bg-white/20",
] as const;

/** A provider's own category breakdown wins. Otherwise cache and reasoning are subsets of
 * input and output, and unclassified context stays visible when only part is reported. */
export function contextWindowSegments(
  usage: Pick<
    ContextWindowSnapshot,
    "usedTokens" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningOutputTokens"
  > &
    Partial<Pick<ContextWindowSnapshot, "breakdown">>,
  resolve: MessageResolver = m,
) {
  const categories = (usage.breakdown ?? [])
    .filter((category) => category.tokens > 0)
    .toSorted((a, b) => b.tokens - a.tokens);
  if (categories.length > 0) {
    return categories.map((category, index) => ({
      label: resolve(CONTEXT_BREAKDOWN_LABELS[category.kind]),
      tokens: category.tokens,
      color: CONTEXT_BREAKDOWN_COLORS[Math.min(index, CONTEXT_BREAKDOWN_COLORS.length - 1)]!,
    }));
  }
  const input = usage.inputTokens ?? usage.cachedInputTokens ?? 0;
  const cached = Math.min(input, usage.cachedInputTokens ?? 0);
  const output = usage.outputTokens ?? usage.reasoningOutputTokens ?? 0;
  const reasoning = Math.min(output, usage.reasoningOutputTokens ?? 0);
  const reported = [
    { label: resolve(msg("Cached input")), tokens: cached, color: "bg-black/80 dark:bg-white/80" },
    { label: resolve(msg("New input")), tokens: input - cached, color: "bg-black/50 dark:bg-white/50" },
    { label: resolve(msg("Output", { $context: "output tokens" })), tokens: output - reasoning, color: "bg-black/32 dark:bg-white/32" },
    { label: resolve(msg("Reasoning", { $context: "reasoning tokens" })), tokens: reasoning, color: "bg-black/20 dark:bg-white/20" },
  ];
  let remaining = usage.usedTokens;
  const segments = reported.flatMap((segment) => {
    const tokens = Math.max(0, Math.min(remaining, segment.tokens));
    remaining -= tokens;
    return tokens > 0 ? [{ ...segment, tokens }] : [];
  });
  if (remaining > 0 || segments.length === 0) {
    segments.push({
      label: segments.length ? resolve(msg("Other context")) : resolve(msg("Used context")),
      tokens: remaining,
      color: "bg-black/80 dark:bg-white/80",
    });
  }
  return segments;
}
