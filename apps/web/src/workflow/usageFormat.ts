import { formatDuration } from "~/session-logic";

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) {
    return `${tokens} tok`;
  }
  if (tokens < 1_000_000) {
    const thousands = tokens / 1_000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k tok`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M tok`;
}

export function ticketUsageSummary(ticket: {
  readonly totalTokens?: number | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly tokenBudget?: number | undefined;
}): string | null {
  const parts: string[] = [];
  if (ticket.tokenBudget !== undefined && ticket.tokenBudget > 0) {
    parts.push(
      `${formatTokenCount(ticket.totalTokens ?? 0)} / ${formatTokenCount(ticket.tokenBudget)}`,
    );
  } else if (ticket.totalTokens !== undefined && ticket.totalTokens > 0) {
    parts.push(formatTokenCount(ticket.totalTokens));
  }
  if (ticket.totalDurationMs !== undefined && ticket.totalDurationMs > 0) {
    parts.push(formatDuration(ticket.totalDurationMs));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function stepUsageSummary(step: {
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
  readonly usage?: { readonly totalTokens?: number | undefined } | undefined;
}): string | null {
  const parts: string[] = [];
  if (step.startedAt !== undefined && step.finishedAt !== undefined) {
    const durationMs = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      parts.push(formatDuration(durationMs));
    }
  }
  if (step.usage?.totalTokens !== undefined && step.usage.totalTokens > 0) {
    parts.push(formatTokenCount(step.usage.totalTokens));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
