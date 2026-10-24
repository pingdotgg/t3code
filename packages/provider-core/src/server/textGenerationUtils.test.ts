import { describe, expect, it } from "vite-plus/test";

import { sanitizeCommitDescription, sanitizeCommitSubject } from "./textGenerationUtils.ts";

it("limits a commit description to one line, ten words, and 80 characters", () => {
  const description = sanitizeCommitDescription(
    "  Update the selected commit preview and branch fallback for unavailable history with extra words\nignored  ",
  );
  expect(description).toBe(
    "Update the selected commit preview and branch fallback for unavailable",
  );
  expect(description.length).toBeLessThanOrEqual(80);
});

it.each([
  { prefixLength: 79, character: "🚀" },
  { prefixLength: 79, character: "e\u0301" },
  { prefixLength: 73, character: "👨‍👩‍👧‍👦" },
])("keeps description graphemes intact at the limit", ({ prefixLength, character }) => {
  const prefix = "a".repeat(prefixLength);
  expect(sanitizeCommitDescription(`${prefix}${character} more`)).toBe(prefix);
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
