import { describe, expect, it } from "vite-plus/test";

import { resolveTextDirection } from "./textDirection.js";

describe("resolveTextDirection", () => {
  it.each([
    ["العربية مع English terms", "rtl"],
    ["React Server Components האם להשתמש בהם בפרויקט החדש שלנו?", "rtl"],
    ["English text with one كلمة", "ltr"],
    ["one two three four עברית עברית עברית עברית", "ltr"],
    ["👋 123...", "ltr"],
  ] as const)("resolves %s as %s", (text, direction) => {
    expect(resolveTextDirection(text)).toBe(direction);
  });

  it("bounds neutral-prefix inspection", () => {
    expect(resolveTextDirection(`${".".repeat(8_192)}العربية`)).toBe("ltr");
  });
});
