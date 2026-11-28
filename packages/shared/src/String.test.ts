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
});
