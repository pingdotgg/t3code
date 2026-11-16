import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import { resolveFyiMarker, type FyiCarrierRun } from "@t3tools/client-runtime/fork/fyi-marker";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

/** The badge an agent's FYI message shows in place of the steer badge, or null. */
export function resolveFyiIntentBadge(
  item: OrchestrationV2TurnItem | undefined,
  fyiRuns: ReadonlyMap<RunId, FyiCarrierRun> | undefined,
): {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly symbol: AppSymbolName;
} | null {
  const fyi = resolveFyiMarker(item, item?.runId ? fyiRuns?.get(item.runId) : undefined);
  return fyi === null
    ? null
    : { label: fyi.label, accessibilityLabel: fyi.description, symbol: "info.circle" };
}
