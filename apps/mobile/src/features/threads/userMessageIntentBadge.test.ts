import { describe, expect, it } from "@effect/vitest";

import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";

describe("user message intent badge", () => {
  it("does not label ordinary turn-start messages", () => {
    expect(resolveUserMessageIntentBadge(undefined)).toBeNull();
    expect(resolveUserMessageIntentBadge("turn_start")).toBeNull();
  });

  it("labels messages waiting behind the active turn", () => {
    expect(resolveUserMessageIntentBadge("queued_turn")).toEqual({
      label: "queued",
      accessibilityLabel: "Queued behind the active turn",
      tone: "queued",
    });
  });

  it("labels messages that steer the active turn", () => {
    expect(resolveUserMessageIntentBadge("steer")).toEqual({
      label: "steer",
      accessibilityLabel: "Steered the active turn",
      tone: "steer",
    });
  });

  it("preserves the queued origin after promotion to steer", () => {
    expect(resolveUserMessageIntentBadge("promoted_queued_to_steer")).toEqual({
      label: "queued → steer",
      accessibilityLabel: "Originally queued, then promoted to steer the active turn",
      tone: "steer",
    });
  });
});
