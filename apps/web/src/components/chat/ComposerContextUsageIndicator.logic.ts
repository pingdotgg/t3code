import {
  deriveContextUsageSeverity,
  type ThreadContextUsageSeverity,
  type ThreadContextUsageSnapshot,
} from "../../session-logic";

export interface ComposerContextUsageIndicatorViewModel {
  severity: ThreadContextUsageSeverity;
  progressPercent: number | null;
  summaryLine: string;
  tokensLine: string;
  showCompactionNotice: boolean;
  ariaLabel: string;
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}

function formatCompactTokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  })
    .format(value)
    .toLowerCase();
}

export function buildComposerContextUsageIndicatorViewModel(
  snapshot: ThreadContextUsageSnapshot | null,
): ComposerContextUsageIndicatorViewModel {
  const usedTokens = snapshot?.usedTokens ?? null;
  const maxTokens = snapshot?.maxTokens ?? null;
  const percentUsed = snapshot?.percentUsed ?? null;
  const showCompactionNotice = snapshot?.recentlyCompacted ?? false;
  const hasUsage = usedTokens !== null || maxTokens !== null;
  const progressPercent = maxTokens !== null && percentUsed !== null ? percentUsed : null;
  const severity = deriveContextUsageSeverity(progressPercent);
  const summaryLine =
    progressPercent !== null
      ? `${formatPercent(progressPercent)} used (${formatPercent(Math.max(0, 100 - progressPercent))} left)`
      : usedTokens !== null
        ? `${formatCompactTokenCount(usedTokens)} used (max unknown)`
        : "Context usage unavailable";
  const tokensLine = !hasUsage
    ? "Usage not yet available"
    : maxTokens !== null
      ? `${formatCompactTokenCount(usedTokens ?? 0)} / ${formatCompactTokenCount(maxTokens)} tokens used`
      : `${formatCompactTokenCount(usedTokens ?? 0)} tokens used`;

  const ariaLabelParts = [summaryLine, tokensLine];
  if (showCompactionNotice) {
    ariaLabelParts.push("Context was compacted recently.");
  }

  return {
    severity,
    progressPercent,
    summaryLine,
    tokensLine,
    showCompactionNotice,
    ariaLabel: ariaLabelParts.join(" "),
  };
}
