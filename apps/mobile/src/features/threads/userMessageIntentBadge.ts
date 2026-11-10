import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";
import { STEER_DELIVERY_COPY, type SteerDelivery } from "@t3tools/client-runtime/user-message";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
  delivery?: SteerDelivery,
): UserMessageIntentBadgePresentation | null {
  switch (intent) {
    case "steer":
    case "promoted_queued_to_steer": {
      const copy = STEER_DELIVERY_COPY[delivery ?? "read"];
      return {
        label: copy.label,
        accessibilityLabel:
          delivery === undefined && intent === "promoted_queued_to_steer"
            ? "Originally queued, then promoted to steer the active turn"
            : copy.description,
      };
    }
    case "queued_turn":
    case "turn_start":
    case undefined:
      return null;
  }
}
