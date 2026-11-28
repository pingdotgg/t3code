import { describe, expect, it } from "vite-plus/test";

import { truncate } from "./String.ts";

describe("truncate", () => {
  it("cuts by Unicode code point so emoji stay whole", () => {
    expect(truncate("👍👍👍", 5)).toBe("👍👍👍");
    expect(truncate("👍👍👍👍", 3)).toBe("👍👍👍...");
  });

  it("trims before measuring", () => {
    expect(truncate("  hello  ", 5)).toBe("hello");
  });

  it("drops whitespace at the cut before the ellipsis", () => {
    expect(truncate("hello world", 6)).toBe("hello...");
  });

  it("does not split combining marks when truncating", () => {
    expect(truncate("किताब", 1)).toBe("...");
    expect(truncate("किताब", 3)).toBe("कि...");
    expect(truncate("किताब", 5)).toBe("किताब");
    expect(truncate("नमस्ते", 3)).toBe("नम...");
    expect(truncate("ที่บ้าน", 2)).toBe("...");
    expect(truncate("บ้านที่", 6)).toBe("บ้าน...");
    expect(truncate("cafe\u0301!", 4)).toBe("caf...");
    expect(truncate("\u26A0\uFE0F\u26A0\uFE0F", 3)).toBe("\u26A0\uFE0F...");
    expect(truncate("\u0301\u0302ab", 1)).toBe("...");
    expect(truncate("\u0301\u0302ab", 3)).toBe("\u0301\u0302a...");
    expect(truncate("e\u0301".repeat(10), 5)).toBe("e\u0301e\u0301...");
  });
});
