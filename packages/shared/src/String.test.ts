import { describe, expect, it } from "vite-plus/test";

import { truncate } from "./String.ts";

describe("truncate", () => {
  it("never leaves half of an emoji at the cut", () => {
    expect(truncate("abcd😀 more", 5)).toBe("abcd...");
    expect(truncate("abc😀 more", 5)).toBe("abc😀...");
  });

  it("keeps a grapheme cluster whole at the cut", () => {
    expect(truncate("ab👨‍👩‍👧‍👦 x", 12)).toBe("ab...");
    expect(truncate("abc👍🏽 z", 5)).toBe("abc...");
    expect(truncate("café au lait", 4)).toBe("caf...");
    expect(truncate("🇳🇱🇩🇪abc", 6)).toBe("🇳🇱...");
  });
});
