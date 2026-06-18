import { describe, expect, it } from "@effect/vitest";

import {
  normalizeThreadConversationMaxWidth,
  THREAD_CONVERSATION_MAX_WIDTH_PX,
  THREAD_CONVERSATION_MIN_WIDTH_PX,
} from "./displayPreferences.ts";

describe("normalizeThreadConversationMaxWidth", () => {
  it("returns null for unset or non-finite values", () => {
    expect(normalizeThreadConversationMaxWidth(null)).toBeNull();
    expect(normalizeThreadConversationMaxWidth(undefined)).toBeNull();
    expect(normalizeThreadConversationMaxWidth(Number.NaN)).toBeNull();
    expect(normalizeThreadConversationMaxWidth(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds and clamps finite widths", () => {
    expect(normalizeThreadConversationMaxWidth(960.4)).toBe(960);
    expect(normalizeThreadConversationMaxWidth(960.5)).toBe(961);
    expect(normalizeThreadConversationMaxWidth(120)).toBe(THREAD_CONVERSATION_MIN_WIDTH_PX);
    expect(normalizeThreadConversationMaxWidth(5000)).toBe(THREAD_CONVERSATION_MAX_WIDTH_PX);
  });
});
