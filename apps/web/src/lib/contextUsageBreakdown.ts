import type { ProviderContextUsage, ProviderContextUsageCategory } from "@t3tools/contracts";

/**
 * Colors for the segmented context bar and its legend. Named categories keep a
 * stable color across sessions; anything the provider adds later falls back to
 * the rotating palette. Free space and deferred slices are drawn muted because
 * they do not occupy the window.
 */
const CATEGORY_COLORS: Readonly<Record<string, string>> = {
  "System prompt": "#d9a441",
  "System tools": "#4f8ef7",
  "MCP tools": "#f0783c",
  Messages: "#3fb27f",
  Skills: "#e0529a",
  "Memory files": "#9a9a9a",
  "Custom agents": "#7a7a7a",
  "Slash commands": "#8b6ee8",
  "Autocompact buffer": "#5a5a5a",
};

const FALLBACK_COLORS = ["#4f8ef7", "#f0783c", "#3fb27f", "#d9a441", "#e0529a", "#8b6ee8"];

const FREE_SPACE_CATEGORY = "Free space";
const MUTED_COLOR = "color-mix(in oklab, var(--color-muted-foreground) 45%, transparent)";
const FREE_COLOR = "color-mix(in oklab, var(--color-muted-foreground) 18%, transparent)";

export interface ContextUsageRow {
  readonly name: string;
  readonly tokens: number;
  /** Null for deferred slices, which are counted but not resident. */
  readonly percentage: number | null;
  readonly color: string;
  readonly deferred: boolean;
  readonly free: boolean;
}

export interface ContextUsageBreakdownView {
  readonly model: string;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly usedPercentage: number;
  /** Resident slices first (largest to smallest), then free space, then deferred. */
  readonly rows: ReadonlyArray<ContextUsageRow>;
  /** Only resident slices, for the segmented bar. */
  readonly segments: ReadonlyArray<ContextUsageRow>;
  readonly groups: ProviderContextUsage["groups"];
}

function isFreeSpace(category: ProviderContextUsageCategory): boolean {
  return category.name === FREE_SPACE_CATEGORY;
}

export function buildContextUsageBreakdownView(
  usage: ProviderContextUsage,
): ContextUsageBreakdownView {
  const maxTokens = Math.max(1, usage.maxTokens);
  let fallbackIndex = 0;
  const colorFor = (category: ProviderContextUsageCategory): string => {
    if (isFreeSpace(category)) return FREE_COLOR;
    if (category.deferred) return MUTED_COLOR;
    const named = CATEGORY_COLORS[category.name];
    if (named) return named;
    const color = FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length] ?? MUTED_COLOR;
    fallbackIndex += 1;
    return color;
  };

  const byTokensDesc = (left: ProviderContextUsageCategory, right: ProviderContextUsageCategory) =>
    right.tokens - left.tokens;
  const resident = usage.categories
    .filter((category) => !category.deferred && !isFreeSpace(category))
    .sort(byTokensDesc);
  const free = usage.categories.filter(isFreeSpace);
  const deferred = usage.categories.filter((category) => category.deferred).sort(byTokensDesc);

  const toRow = (category: ProviderContextUsageCategory): ContextUsageRow => ({
    name: category.name,
    tokens: category.tokens,
    percentage: category.deferred ? null : (category.tokens / maxTokens) * 100,
    color: colorFor(category),
    deferred: category.deferred,
    free: isFreeSpace(category),
  });

  const rows = [...resident, ...free, ...deferred].map(toRow);
  return {
    model: usage.model,
    totalTokens: usage.totalTokens,
    maxTokens,
    usedPercentage: Math.min(100, (usage.totalTokens / maxTokens) * 100),
    rows,
    segments: rows.filter((row) => !row.deferred && !row.free && row.tokens > 0),
    groups: usage.groups,
  };
}

/** One decimal below 100k, so 19,200 reads as 19.2k like the provider's own display. */
export function formatBreakdownTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 100_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Deferred slices have no share of the window, so they render an empty cell. */
export function formatBreakdownPercentage(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (value >= 99.95) return "100%";
  return `${value.toFixed(1)}%`;
}
