import {
  formatContextWindowTokens,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";

/** Percentages under 10 keep one decimal so early usage still moves, matching web. */
export function formatContextWindowPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(value)}%`;
}

/**
 * One-line usage summary shown under the composer when the ring is tapped —
 * mobile's stand-in for web's hover tooltip. Falls back to a bare token count
 * when the provider reports no context-window size.
 */
export function formatContextWindowDetail(snapshot: ContextWindowSnapshot): string {
  const percentage = formatContextWindowPercentage(snapshot.usedPercentage);
  const maxTokens = snapshot.maxTokens ?? null;
  if (maxTokens === null || percentage === null) {
    return `Context window · ${formatContextWindowTokens(snapshot.usedTokens)} tokens used`;
  }
  return `Context window · ${percentage} · ${formatContextWindowTokens(snapshot.usedTokens)}/${formatContextWindowTokens(maxTokens)}`;
}
