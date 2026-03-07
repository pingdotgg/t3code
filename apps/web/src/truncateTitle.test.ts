import { describe, expect, it } from "vitest";

import { truncateTitle } from "./truncateTitle";

describe("truncateTitle", () => {
  it("trims surrounding whitespace", () => {
    expect(truncateTitle("   hello world   ")).toBe("hello world");
  });

  it("returns trimmed text when within max length", () => {
    expect(truncateTitle("alpha", 10)).toBe("alpha");
  });

  it("appends ellipsis when text exceeds max length", () => {
    expect(truncateTitle("abcdefghij", 5)).toBe("abcde...");
  });
});
