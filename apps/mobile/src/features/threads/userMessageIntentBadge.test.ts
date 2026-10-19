import { describe, expect, it } from "@effect/vitest";

import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";

describe("user message intent badge", () => {
  it("does not label ordinary turn-start messages", () => {
    expect(resolveUserMessageIntentBadge(undefined)).toBeNull();
    expect(resolveUserMessageIntentBadge("turn_start")).toBeNull();
  });

  it("explains the queued history without claiming delivery", () => {
    expect(resolveUserMessageIntentBadge("queued_turn")).toEqual({
      label: "From queue",
      accessibilityLabel: "Queued while the agent was busy",
      icon: null,
    });
  });

  it("explains the intent to steer without claiming delivery", () => {
    expect(resolveUserMessageIntentBadge("steer")).toEqual({
      label: "Steer",
      accessibilityLabel: "Steered the active turn",
      icon: "arrow.uturn.forward",
    });
  });

  it("preserves the queued origin after promotion to steer", () => {
    expect(resolveUserMessageIntentBadge("promoted_queued_to_steer")).toEqual({
      label: "Steer",
      accessibilityLabel: "Originally queued, then promoted to steer the active turn",
      icon: "arrow.uturn.forward",
    });
  });
});
