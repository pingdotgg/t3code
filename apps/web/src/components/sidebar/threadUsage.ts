import type { OrchestrationV2ThreadUsage } from "@t3tools/contracts";

import { formatContextWindowTokens } from "~/lib/contextWindow";

export interface ThreadUsageRow {
  readonly label: string;
  readonly value: string;
}

/**
 * Rows for the sidebar hover card. Empty when the thread has no usage to show,
 * so the card renders without a usage block. Cost and cumulative totals are not
 * included because `orchestration.getThreadUsage` does not return them.
 */
export function deriveThreadUsageRows(
  usage: OrchestrationV2ThreadUsage | null | undefined,
): ReadonlyArray<ThreadUsageRow> {
  const rows: ThreadUsageRow[] = [];

  const turn = usage?.latestTurnTokenUsage ?? null;
  // Same source order as the chat context meter: the latest turn first, then the
  // stored provider context snapshot, which can be stale after compaction.
  const context =
    turn !== null
      ? { usedTokens: turn.usedTokens, maxTokens: turn.maxTokens }
      : (usage?.providerThread?.contextUsage ?? null);
  if (context !== null) {
    const used = formatContextWindowTokens(context.usedTokens);
    const max = context.maxTokens;
    rows.push(
      max === undefined || max === null || max <= 0
        ? { label: "Context", value: `${used} tokens` }
        : {
            label: "Context",
            value: `${used} / ${formatContextWindowTokens(max)} (${Math.min(100, Math.round((context.usedTokens / max) * 100))}%)`,
          },
    );
  }

  if (turn !== null) {
    rows.push({
      label: "Last turn",
      value: `${formatContextWindowTokens(turn.usedTokens)} tokens`,
    });
    if (turn.inputTokens !== undefined) {
      rows.push({ label: "Input", value: formatContextWindowTokens(turn.inputTokens) });
    }
    if (turn.outputTokens !== undefined) {
      rows.push({ label: "Output", value: formatContextWindowTokens(turn.outputTokens) });
    }
    if (turn.cachedInputTokens !== undefined) {
      rows.push({
        label: "Cached input",
        value: formatContextWindowTokens(turn.cachedInputTokens),
      });
    }
  }

  return rows;
}
