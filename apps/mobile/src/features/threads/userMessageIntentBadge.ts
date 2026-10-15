import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly explanation: string;
  readonly tone: "queued" | "steer";
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
): UserMessageIntentBadgePresentation | null {
  switch (intent) {
    case "queued_turn":
      return {
        label: "from queue",
        accessibilityLabel: "Queued while the agent was busy",
        explanation:
          "This badge records that the message was queued. It stays visible after the message leaves the queue.",
        tone: "queued",
      };
    case "steer":
      return {
        label: "steer",
        accessibilityLabel: "Steered the active turn",
        explanation:
          "This message was intended to steer the agent while its turn was still running.",
        tone: "steer",
      };
    case "promoted_queued_to_steer":
      return {
        label: "queued → steer",
        accessibilityLabel: "Originally queued, then promoted to steer the active turn",
        explanation:
          "This message was originally queued, then promoted to steer the agent while its turn was still running.",
        tone: "steer",
      };
    case "turn_start":
    case undefined:
      return null;
  }
}
