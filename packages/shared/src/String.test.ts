import { describe, expect, it } from "vite-plus/test";

import { truncate } from "./String.ts";

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("hello", 50)).toBe("hello");
  });

  it("cuts by Unicode code point so emoji stay whole", () => {
    expect(truncate("👍👍👍", 5)).toBe("👍👍👍");
    expect(truncate("👍👍👍👍", 3)).toBe("👍👍👍...");
  });

  it("trims before measuring", () => {
    expect(truncate("  hello  ", 5)).toBe("hello");
  });
});
