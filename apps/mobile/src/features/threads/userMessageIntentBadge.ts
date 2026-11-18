import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
  unread = false,
  resolve: MessageResolver = m,
): UserMessageIntentBadgePresentation | null {
  if (unread && (intent === "steer" || intent === "promoted_queued_to_steer")) {
    return {
      label: resolve(msg("Steer · waiting to be read")),
      accessibilityLabel: resolve(
        msg("Steer waiting for the agent to read it after the running command finishes"),
      ),
    };
  }
  switch (intent) {
    case "steer":
      return {
        label: resolve(msg("Steer", { $context: "badge, message sent into the running turn" })),
        accessibilityLabel: resolve(msg("Steered the active turn")),
      };
    case "promoted_queued_to_steer":
      return {
        label: resolve(msg("Steer", { $context: "badge, message sent into the running turn" })),
        accessibilityLabel: resolve(
          msg("Originally queued, then promoted to steer the active turn"),
        ),
      };
    case "queued_turn":
    case "turn_start":
    case undefined:
      return null;
  }
}
