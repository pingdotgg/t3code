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
    expect(truncate(`${family} x`, 4)).toBe("👨...");
    expect(truncate(`${family} x`, 6)).toBe("👨‍👩...");
    expect(truncate(`${family} x`, 11)).toBe(`${family}...`);
  });

  it("never splits a flag emoji", () => {
    expect(truncate("🇳🇱abc", 3)).toBe("...");
    expect(truncate("🇳🇱abc", 5)).toBe("🇳🇱a...");
    expect(truncate("🇳🇱🇩🇪abc", 6)).toBe("🇳🇱...");
  });
});
