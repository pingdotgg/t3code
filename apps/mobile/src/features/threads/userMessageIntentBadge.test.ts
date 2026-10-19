import { describe, expect, it } from "@effect/vitest";

import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";

describe("user message intent badge", () => {
  it("does not label turn-start or queued messages", () => {
    expect(resolveUserMessageIntentBadge(undefined)).toBeNull();
    expect(resolveUserMessageIntentBadge("turn_start")).toBeNull();
    expect(resolveUserMessageIntentBadge("queued_turn")).toBeNull();
  });

  it("explains the intent to steer without claiming delivery", () => {
    expect(resolveUserMessageIntentBadge("steer")).toEqual({
      label: "Steer",
      accessibilityLabel: "Steered the active turn",
    });
  });

  it("preserves the queued origin after promotion to steer", () => {
    expect(resolveUserMessageIntentBadge("promoted_queued_to_steer")).toEqual({
      label: "Steer",
      accessibilityLabel: "Originally queued, then promoted to steer the active turn",
    });
  });
});
