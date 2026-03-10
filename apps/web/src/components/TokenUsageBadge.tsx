import { useMemo } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { useTokenUsageStore } from "../tokenUsageStore";

function formatTokenCount(tokens: number): string {
  if (tokens === 0) return "0";
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
}

interface TokenUsageBadgeProps {
  threadId: ThreadId;
}

export function TokenUsageBadge({ threadId }: TokenUsageBadgeProps) {
  const threadUsage = useTokenUsageStore((s) => s.threadUsage[threadId]);
  const todayUsage = useTokenUsageStore((s) => s.getTodayUsage());
  const rateLimits = useTokenUsageStore((s) => s.rateLimits);

  const hasUsage = threadUsage && threadUsage.totalTokens > 0;
  const hasDailyUsage = todayUsage.totalTokens > 0;
  const hasRateLimitWarning = rateLimits.some((r) => {
    const limits = r.limits as Record<string, unknown>;
    return limits.remaining !== undefined && (limits.remaining as number) < 100;
  });

  const lastTurn = useMemo(() => {
    if (!threadUsage?.turns.length) return null;
    return threadUsage.turns[threadUsage.turns.length - 1]!;
  }, [threadUsage?.turns.length]);

  if (!hasUsage && !hasDailyUsage) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {/* Thread session tokens */}
      {hasUsage && (
        <div
          className="flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5"
          title={`Thread: ${formatTokenCount(threadUsage.totalTokens)} tokens${threadUsage.totalCostUsd > 0 ? ` (${formatCost(threadUsage.totalCostUsd)})` : ""}\nLast turn: ${lastTurn ? formatTokenCount(lastTurn.totalTokens) + " tokens" : "—"}`}
        >
          <svg
            className="h-3 w-3 opacity-60"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="8" cy="8" r="6" />
            <path d="M8 4v4l3 2" />
          </svg>
          <span>{formatTokenCount(threadUsage.totalTokens)}</span>
          {threadUsage.totalCostUsd > 0 && (
            <span className="opacity-60">{formatCost(threadUsage.totalCostUsd)}</span>
          )}
        </div>
      )}

      {/* Daily usage */}
      {hasDailyUsage && (
        <div
          className="flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5"
          title={`Today: ${formatTokenCount(todayUsage.totalTokens)} tokens, ${todayUsage.turnCount} turns${todayUsage.totalCostUsd > 0 ? `, ${formatCost(todayUsage.totalCostUsd)}` : ""}`}
        >
          <span className="opacity-60">today</span>
          <span>{formatTokenCount(todayUsage.totalTokens)}</span>
        </div>
      )}

      {/* Rate limit warning */}
      {hasRateLimitWarning && (
        <div
          className="flex items-center gap-1 rounded-md bg-yellow-500/10 px-2 py-0.5 text-yellow-600 dark:text-yellow-400"
          title="Approaching rate limit"
        >
          <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1l7 14H1L8 1zm0 4v5m0 2v1" />
          </svg>
          <span>limit</span>
        </div>
      )}
    </div>
  );
}
