import { describe, expect, it } from "vite-plus/test";

import {
  sanitizeCommitSubject,
  sanitizeSideChatText,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

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

describe("sanitizeSideChatText", () => {
  it("trims the text", () => {
    expect(sanitizeSideChatText("  They never met Box spaces.  ", 300)).toBe(
      "They never met Box spaces.",
    );
  });

  it.each([
    { name: "blank text", raw: "   " },
    { name: "a null placeholder", raw: "null" },
    { name: "a none placeholder with a period", raw: "None." },
    { name: "an n/a placeholder", raw: "n/a" },
    { name: "a null value", raw: null },
  ])("treats $name as no text", ({ raw }) => {
    expect(sanitizeSideChatText(raw, 300)).toBeNull();
  });

  it("cuts at a whole grapheme and marks the cut with an ellipsis", () => {
    expect(sanitizeSideChatText(`${"a".repeat(298)}🚀 more`, 300)).toBe(`${"a".repeat(298)}…`);
  });
});

describe("sanitizeThreadTitle", () => {
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
