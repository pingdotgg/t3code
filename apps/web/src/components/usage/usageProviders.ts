import type { UsageLimitsProviderKind, UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, GrokIcon, type Icon, OpenAI, OpenCodeIcon } from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation, keyed by the wider limits union: the Limits view
 * also presents providers (OpenCode) that report subscription limits without
 * having transcript-based usage series.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    mark: OpenAI,
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
  grok: {
    label: "Grok Build",
    // Contrast-aware neutral between the Codex series and muted chart chrome.
    color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))",
    mark: GrokIcon,
  },
  opencode: {
    label: "OpenCode",
    color: "var(--foreground)",
    mark: OpenCodeIcon,
  },
} satisfies Record<UsageLimitsProviderKind, UsageProviderPresentation>;

/**
 * Stable provider reading order across charts, summaries, tables, and hover
 * rows. Only providers with transcript-based usage series belong here.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "grok"];

/** Providers with real activity, independent of the metric currently displayed. */
export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}
