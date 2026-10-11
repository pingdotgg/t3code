import { describe, expect, it } from "vite-plus/test";

import { truncate } from "./String.ts";

describe("truncate", () => {
  it("keeps short text and trims whitespace", () => {
    expect(truncate("  hello  ", 10)).toBe("hello");
  });

  it("cuts long text at the limit", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcde...");
  });

  it("never leaves half of an emoji at the cut", () => {
    expect(truncate("abcd😀 more", 5)).toBe("abcd...");
    expect(truncate("abc😀 more", 5)).toBe("abc😀...");
  });

  it("never cuts a ZWJ emoji sequence in half", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(truncate(`${family} x`, 4)).toBe("...");
    expect(truncate(`${family} x`, 6)).toBe("...");
    expect(truncate(`ab${family} x`, 13)).toBe(`ab${family}...`);
    expect(truncate(`ab${family} x`, 12)).toBe("ab...");
  });

  it("keeps a skin tone, variation selector or combining mark with its base", () => {
    expect(truncate("abc👍🏽 z", 5)).toBe("abc...");
    expect(truncate("abc👍🏽 z", 7)).toBe("abc👍🏽...");
    expect(truncate("abc❤️ z", 4)).toBe("abc...");
    expect(truncate("abc1️⃣ z", 5)).toBe("abc...");
    expect(truncate("cafe\u0301 au lait", 4)).toBe("caf...");
  });

  it("never splits a flag emoji", () => {
    expect(truncate("🇳🇱abc", 3)).toBe("...");
    expect(truncate("🇳🇱abc", 5)).toBe("🇳🇱a...");
    expect(truncate("🇳🇱🇩🇪abc", 6)).toBe("🇳🇱...");
  });
});
