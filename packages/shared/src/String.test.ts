import { describe, expect, it } from "vite-plus/test";

import { truncate } from "./String.ts";

describe("truncate", () => {
  it("cuts before a surrogate pair that would be split", () => {
    expect(truncate("abcd😀 more", 5)).toBe("abcd...");
  });

  it("keeps a surrogate pair that fits exactly", () => {
    expect(truncate("abc😀 more", 5)).toBe("abc😀...");
  });

  it("keeps ASCII and BMP truncation lengths", () => {
    expect(truncate("  hello world  ", 5)).toBe("hello...");
    expect(truncate("日本語のテキスト", 3)).toBe("日本語...");
    expect(truncate("short", 5)).toBe("short");
  });
});
