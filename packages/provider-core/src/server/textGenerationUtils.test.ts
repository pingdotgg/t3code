import { describe, expect, it } from "vite-plus/test";

import { sanitizeCommitSubject } from "./textGenerationUtils.ts";

describe("sanitizeCommitSubject", () => {
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "an emoji with a skin tone", prefixLength: 70, character: "👍🏽" },
    { name: "a flag", prefixLength: 69, character: "🇮🇹" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});
