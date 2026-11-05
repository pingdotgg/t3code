import { describe, expect, it } from "vite-plus/test";

import { limitSection, sanitizeCommitSubject, sanitizeThreadTitle } from "./textGenerationUtils.ts";

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
    { raw: "`Fix login redirect`", expected: "Fix login redirect" },
    { raw: "Explain `vp check`", expected: "Explain `vp check`" },
    { raw: '"Open in" menu ignores Finder', expected: '"Open in" menu ignores Finder' },
    { raw: 'Rename "foo" to "bar"', expected: 'Rename "foo" to "bar"' },
    { raw: '"Open in" ignores "Finder"', expected: '"Open in" ignores "Finder"' },
    { raw: "Sync contributors'", expected: "Sync contributors'" },
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
