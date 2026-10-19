import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName | null;
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
): UserMessageIntentBadgePresentation | null {
  switch (intent) {
    case "queued_turn":
      return {
        label: "From queue",
        accessibilityLabel: "Queued while the agent was busy",
        icon: null,
      };
    case "steer":
      return {
        label: "Steer",
        accessibilityLabel: "Steered the active turn",
        icon: "arrow.uturn.forward",
      };
    case "promoted_queued_to_steer":
      return {
        label: "Steer",
        accessibilityLabel: "Originally queued, then promoted to steer the active turn",
        icon: "arrow.uturn.forward",
      };
    case "turn_start":
    case undefined:
      return null;
  }
}
