import { describe, expect, it } from "@effect/vitest";

import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";

describe("user message intent badge", () => {
  it("does not label ordinary turn-start messages", () => {
    expect(resolveUserMessageIntentBadge(undefined)).toBeNull();
    expect(resolveUserMessageIntentBadge("turn_start")).toBeNull();
  });

  it("explains the queued history without claiming delivery", () => {
    expect(resolveUserMessageIntentBadge("queued_turn")).toEqual({
      label: "from queue",
      accessibilityLabel: "Queued while the agent was busy",
      explanation:
        "This badge records that the message was queued. It stays visible after the message leaves the queue.",
      tone: "queued",
    });
  });

  it("explains the intent to steer without claiming delivery", () => {
    expect(resolveUserMessageIntentBadge("steer")).toEqual({
      label: "steer",
      accessibilityLabel: "Steered the active turn",
      explanation: "This message was intended to steer the agent while its turn was still running.",
      tone: "steer",
    });
  });

  it("preserves the queued origin after promotion to steer", () => {
    expect(resolveUserMessageIntentBadge("promoted_queued_to_steer")).toEqual({
      label: "queued → steer",
      accessibilityLabel: "Originally queued, then promoted to steer the active turn",
      explanation:
        "This message was originally queued, then promoted to steer the agent while its turn was still running.",
      tone: "steer",
    });
  });
});
