import type {
  ContextBreakdownKind,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

const CONTEXT_BREAKDOWN_LABELS: Record<ContextBreakdownKind, string> = {
  system_prompt: "System prompt",
  system_tools: "System tools",
  mcp_tools: "MCP tools",
  t3_tools: "T3 Code tools",
  memory_files: "Memory files",
  skills: "Skills",
  custom_agents: "Custom agents",
  messages: "Messages",
  other: "Other",
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
) {
  const categories = (usage.breakdown ?? [])
    .filter((category) => category.tokens > 0)
    .toSorted((a, b) => b.tokens - a.tokens);
  if (categories.length > 0) {
    return categories.map((category, index) => ({
      label: CONTEXT_BREAKDOWN_LABELS[category.kind],
      tokens: category.tokens,
      color: CONTEXT_BREAKDOWN_COLORS[Math.min(index, CONTEXT_BREAKDOWN_COLORS.length - 1)]!,
    }));
  }
  const input = usage.inputTokens ?? usage.cachedInputTokens ?? 0;
  const cached = Math.min(input, usage.cachedInputTokens ?? 0);
  const output = usage.outputTokens ?? usage.reasoningOutputTokens ?? 0;
  const reasoning = Math.min(output, usage.reasoningOutputTokens ?? 0);
  const reported = [
    { label: "Cached input", tokens: cached, color: "bg-black/80 dark:bg-white/80" },
    { label: "New input", tokens: input - cached, color: "bg-black/50 dark:bg-white/50" },
    { label: "Output", tokens: output - reasoning, color: "bg-black/32 dark:bg-white/32" },
    { label: "Reasoning", tokens: reasoning, color: "bg-black/20 dark:bg-white/20" },
  ];
  let remaining = usage.usedTokens;
  const segments = reported.flatMap((segment) => {
    const tokens = Math.max(0, Math.min(remaining, segment.tokens));
    remaining -= tokens;
    return tokens > 0 ? [{ ...segment, tokens }] : [];
  });
  if (remaining > 0 || segments.length === 0) {
    segments.push({
      label: segments.length ? "Other context" : "Used context",
      tokens: remaining,
      color: "bg-black/80 dark:bg-white/80",
    });
  }
  return segments;
}

export function providerSupportsManualCompaction(
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

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at about ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return (
    input.meterEnabled &&
    input.detailLoading &&
    input.threadStarted &&
    input.providerReportsContextWindow !== false
  );
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
