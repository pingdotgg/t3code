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

  it("moves the cut back so combining marks stay with their base", () => {
    expect(truncate("cafe\u0301!", 4)).toBe("caf...");
    expect(truncate("नमस्ते", 3)).toBe("नम...");
    expect(truncate("บ้านที่", 6)).toBe("บ้าน...");
    expect(truncate("\u26A0\uFE0F\u26A0\uFE0F", 3)).toBe("\u26A0\uFE0F...");
  });
});
