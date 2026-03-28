import { describe, expect, it } from "vitest";

import { truncateTitle } from "./truncateTitle";

describe("truncateTitle", () => {
  it("trims surrounding whitespace", () => {
    expect(truncateTitle("   hello world   ")).toBe("hello world");
  });

  it("returns shorter strings unchanged", () => {
    expect(truncateTitle("alpha", 10)).toBe("alpha");
  });

  it("truncates long strings and appends an ellipsis", () => {
    expect(truncateTitle("abcdefghij", 5)).toBe("abcde...");
  });
});
