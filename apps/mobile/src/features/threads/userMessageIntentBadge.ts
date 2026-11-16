import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";
import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import type { FyiCarrierRun } from "@t3tools/client-runtime/fork/fyi-marker";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { resolveFyiIntentBadge } from "../../fork/fyi/fyiIntentBadge";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly symbol?: AppSymbolName;
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
  unread = false,
  item?: OrchestrationV2TurnItem,
  fyiRuns?: ReadonlyMap<RunId, FyiCarrierRun>,
): UserMessageIntentBadgePresentation | null {
  const fyi = resolveFyiIntentBadge(item, fyiRuns);
  if (fyi !== null) return fyi;
  if (unread && (intent === "steer" || intent === "promoted_queued_to_steer")) {
    return {
      label: "Steer · waiting to be read",
      accessibilityLabel:
        "Steer waiting for the agent to read it after the running command finishes",
    };
  }
  switch (intent) {
    case "steer":
      return {
        label: "Steer",
        accessibilityLabel: "Steered the active turn",
      };
    case "promoted_queued_to_steer":
      return {
        label: "Steer",
        accessibilityLabel: "Originally queued, then promoted to steer the active turn",
      };
    case "queued_turn":
    case "turn_start":
    case undefined:
      return null;
  }
}
