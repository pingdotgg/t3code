import { describe, expect, it } from "vite-plus/test";

import { sanitizeCommitSubject, sanitizeNextMessageSuggestion } from "./textGenerationUtils.ts";

describe("sanitizeCommitSubject", () => {
  // regression: #19181 truncation split grapheme clusters at the subject limit
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});

describe("sanitizeNextMessageSuggestion", () => {
  it("returns one plain line the composer can show", () => {
    expect(sanitizeNextMessageSuggestion('  "Run the full\n  test suite"  ')).toBe(
      "Run the full test suite",
    );
  });

  it("drops a suggestion too long to read at a glance instead of cutting it off", () => {
    expect(sanitizeNextMessageSuggestion("a".repeat(240))).toBe("a".repeat(240));
    expect(sanitizeNextMessageSuggestion("a".repeat(241))).toBe("");
  });
});
