import { describe, expect, it } from "vite-plus/test";

import { FOLDABLE_NARRATION_MAX_CHARS, isFoldableAssistantNarration } from "./turnFold.ts";

describe("isFoldableAssistantNarration", () => {
  it("folds a short single block", () => {
    expect(isFoldableAssistantNarration("Looking around first.")).toBe(true);
  });

  it("folds text exactly at the length limit but not one character past it", () => {
    expect(isFoldableAssistantNarration("a".repeat(FOLDABLE_NARRATION_MAX_CHARS))).toBe(true);
    expect(isFoldableAssistantNarration("a".repeat(FOLDABLE_NARRATION_MAX_CHARS + 1))).toBe(false);
  });

  it("measures the trimmed text, so surrounding whitespace does not push it over", () => {
    expect(
      isFoldableAssistantNarration(`\n\n  ${"a".repeat(FOLDABLE_NARRATION_MAX_CHARS)}  \n`),
    ).toBe(true);
  });

  it("keeps multi-paragraph text visible even when it is short", () => {
    expect(isFoldableAssistantNarration("First point.\n\nSecond point.")).toBe(false);
    expect(isFoldableAssistantNarration("First point.\n \t \nSecond point.")).toBe(false);
  });

  it("folds a single block that wraps across lines", () => {
    expect(isFoldableAssistantNarration("Checking the config.\nThen the tests.")).toBe(true);
  });

  it("folds whitespace-only text", () => {
    expect(isFoldableAssistantNarration("   \n\n  ")).toBe(true);
  });
});
