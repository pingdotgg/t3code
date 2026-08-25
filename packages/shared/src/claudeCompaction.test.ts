import { describe, expect, it } from "vite-plus/test";

import {
  formatClaudeResumeCompactionQuestion,
  isClaudeResumeCompactionQuestion,
} from "./claudeCompaction.ts";

describe("claude resume compaction copy", () => {
  // The matcher must recognize every question the formatter can produce.
  // This is the drift guard: rewording one side fails here.
  it.each([
    { ageMinutes: 145, estimatedTokens: 275_123 },
    { ageMinutes: 70, estimatedTokens: 100_000 },
    { ageMinutes: 59, estimatedTokens: 1_234_567 },
    { ageMinutes: 0, estimatedTokens: 0 },
  ])("matches its own formatted question (%o)", (input) => {
    const question = formatClaudeResumeCompactionQuestion(input);
    expect(isClaudeResumeCompactionQuestion(question)).toBe(true);
  });

  it("formats ages above and below one hour", () => {
    expect(
      formatClaudeResumeCompactionQuestion({ ageMinutes: 145, estimatedTokens: 275_123 }),
    ).toBe("This session is 2h 25m old and uses 275,123 tokens. Compact it before continuing?");
    expect(formatClaudeResumeCompactionQuestion({ ageMinutes: 45, estimatedTokens: 1_000 })).toBe(
      "This session is 45m old and uses 1,000 tokens. Compact it before continuing?",
    );
  });

  it("does not match unrelated questions", () => {
    expect(
      isClaudeResumeCompactionQuestion("The build cache is large. Compact it before continuing?"),
    ).toBe(false);
  });
});
