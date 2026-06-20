import type { OrchestrationThreadActivity } from "@t3tools/contracts";

// The context-window usage meter — a trimmed port of the web client's
// lib/contextWindow.deriveLatestContextWindowSnapshot. The provider emits
// `context-window.updated` activities carrying token usage; we surface the most
// recent one as a compact header meter (those activities are otherwise hidden
// from the work log).

export interface ContextWindowSnapshot {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly remainingTokens: number | null;
  /** 0–100, or null when the max isn't known. */
  readonly usedPercentage: number | null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Most recent context-window usage from the activity stream, or null. */
export function deriveContextWindow(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") continue;
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) continue;
    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens = maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    return { usedTokens, maxTokens, remainingTokens, usedPercentage };
  }
  return null;
}

/** Compact token count: 940 · 8.5k · 144k · 1.2m. */
export function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** An N-cell bar like ▓▓▓▓▓▓▓░░░ for a 0–100 percentage. */
export function meterBar(percentage: number | null, cells = 10): string {
  if (percentage === null) return "░".repeat(cells);
  const filled = Math.max(0, Math.min(cells, Math.round((percentage / 100) * cells)));
  return "▓".repeat(filled) + "░".repeat(cells - filled);
}

/** "▓▓▓░░ 72% · 144k/200k" or "144k used" when the max is unknown. */
export function formatContextWindow(snapshot: ContextWindowSnapshot): string {
  if (snapshot.maxTokens === null || snapshot.usedPercentage === null) {
    return `${formatTokens(snapshot.usedTokens)} used`;
  }
  const percent = Math.round(snapshot.usedPercentage);
  return `${meterBar(snapshot.usedPercentage, 8)} ${percent}% · ${formatTokens(snapshot.usedTokens)}/${formatTokens(snapshot.maxTokens)}`;
}
