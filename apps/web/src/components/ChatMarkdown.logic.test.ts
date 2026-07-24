import { describe, expect, it } from "vite-plus/test";

import { normalizeGeneratedImageReference } from "./ChatMarkdown.logic";

describe("generated image references", () => {
  it("normalizes Windows separators", () => {
    expect(normalizeGeneratedImageReference("images\\1.jpg")).toBe("images/1.jpg");
  });

  it("accepts single-segment image references", () => {
    expect(normalizeGeneratedImageReference("1.jpg")).toBe("1.jpg");
  });

  it("rejects absolute, traversal, and non-image references", () => {
    expect(normalizeGeneratedImageReference("/tmp/1.jpg")).toBeNull();
    expect(normalizeGeneratedImageReference("C:\\tmp\\1.jpg")).toBeNull();
    expect(normalizeGeneratedImageReference("images/../1.jpg")).toBeNull();
    expect(normalizeGeneratedImageReference("images/1.txt")).toBeNull();
  });
});
