import { describe, expect, it } from "vite-plus/test";

import {
  limitSection,
  sanitizeCommitSubject,
  sanitizePromptSuggestion,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

describe("limitSection", () => {
  it("cuts a long section without splitting an emoji", () => {
    expect(limitSection(`${"a".repeat(9)}🚀 more`, 10)).toBe(`${"a".repeat(9)}\n\n[truncated]`);
  });
});

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

describe("sanitizeThreadTitle", () => {
  it.each([
    { raw: '"Fix login redirect"', expected: "Fix login redirect" },
    { raw: `"Fix user's login"`, expected: "Fix user's login" },
    { raw: "Explain `vp check`", expected: "Explain `vp check`" },
    { raw: '"Open in" menu ignores Finder', expected: '"Open in" menu ignores Finder' },
    { raw: 'Rename "foo" to "bar"', expected: 'Rename "foo" to "bar"' },
    { raw: '"Open in" ignores "Finder"', expected: '"Open in" ignores "Finder"' },
  ])("unwraps only a quote pair around the whole title: $raw", ({ raw, expected }) => {
    expect(sanitizeThreadTitle(raw)).toBe(expected);
  });

  it.each([
    { name: "a split surrogate pair", prefixLength: 116, character: "🚀", retained: "" },
    { name: "a complete surrogate pair", prefixLength: 115, character: "🚀", retained: "🚀" },
    { name: "a BMP character", prefixLength: 116, character: "界", retained: "界" },
  ])("truncates without splitting $name", ({ prefixLength, character, retained }) => {
    const prefix = "a".repeat(prefixLength);
    const title = `${prefix}${character} more`;

    expect(sanitizeThreadTitle(title)).toBe(`${prefix}${retained}...`);
  });
});

describe("sanitizePromptSuggestion", () => {
  it("normalizes single-line suggestions and unwraps matching quotes", () => {
    expect(sanitizePromptSuggestion('  "Run the unit tests next"\nsecond line  ')).toBe(
      "Run the unit tests next",
    );
    expect(sanitizePromptSuggestion("帮我  跑一下   测试")).toBe("帮我 跑一下 测试");
  });

  it.each(["", "   ", "NONE", "none.", "N/A", "null", "No suggestion!", "a".repeat(201)])(
    "returns null for empty, sentinel, or overly long output: %j",
    (raw) => {
      expect(sanitizePromptSuggestion(raw)).toBeNull();
    },
  );
});
