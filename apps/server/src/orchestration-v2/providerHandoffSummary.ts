import type { OrchestrationV2ContextHandoff } from "@t3tools/contracts";
import { renderHistory } from "@t3tools/provider-core/server/handoffBudget";

export function compactProviderHandoffSummary(
  handoff: Pick<OrchestrationV2ContextHandoff, "strategy" | "history">,
  summary: string,
): string | null {
  if (
    (handoff.strategy !== "delta_since_target_last_seen" &&
      handoff.strategy !== "full_thread_summary") ||
    handoff.history === undefined ||
    handoff.history.messages.length === 0
  ) {
    return null;
  }
  const { history } = handoff;
  const transcript = renderHistory(history.messages, "");
  if (!summary.endsWith(transcript)) return null;
  const receipt = summary.slice(0, -transcript.length);
  const prefix = `${history.coverage}\nSelected ${history.messages.length} intact items; omitted ${history.omittedItems} items. `;
  return receipt.startsWith(prefix) ? receipt : null;
}
