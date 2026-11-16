import type { OrchestrationV2ThreadUsage } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";

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

  const context = usage?.providerThread?.contextUsage ?? null;
  if (context !== null) {
    const used = formatContextWindowTokens(context.usedTokens);
    const max = context.maxTokens;
    rows.push(
      max === undefined
        ? { label: "Context", value: `${used} tokens` }
        : {
            label: "Context",
            value: `${used} / ${formatContextWindowTokens(max)} (${Math.round((context.usedTokens / max) * 100)}%)`,
          },
    );
  }

  const turn = usage?.latestTurnTokenUsage ?? null;
  if (turn !== null) {
    rows.push({ label: "Last turn", value: `${formatTokens(turn.usedTokens)} tokens` });
    if (turn.inputTokens !== undefined) {
      rows.push({ label: "Input", value: formatTokens(turn.inputTokens) });
    }
    if (turn.outputTokens !== undefined) {
      rows.push({ label: "Output", value: formatTokens(turn.outputTokens) });
    }
    if (turn.cachedInputTokens !== undefined) {
      rows.push({ label: "Cached input", value: formatTokens(turn.cachedInputTokens) });
    }
  }

  return rows;
}
