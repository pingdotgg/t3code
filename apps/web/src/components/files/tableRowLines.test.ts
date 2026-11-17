import { describe, expect, it } from "vite-plus/test";
import { estimateRowLines, tableRowMinHeight } from "./tableRowLines";

describe("estimateRowLines", () => {
  const widths = [128, 128, 128];
  it("keeps short cells on one line", () => {
    expect(estimateRowLines(["a", "b", "c"], widths)).toBe(1);
  });
  it("uses the tallest cell, even one that is far off screen", () => {
    expect(estimateRowLines(["a", "b", "x".repeat(60)], widths)).toBe(4);
  });
  it("counts explicit newlines", () => {
    expect(estimateRowLines(["one\ntwo\nthree"], widths)).toBe(3);
  });
  it("treats a missing row as one line", () => {
    expect(estimateRowLines(undefined, widths)).toBe(1);
  });
});

describe("tableRowMinHeight", () => {
  it("matches the 29px single-line row", () => {
    expect(tableRowMinHeight(1)).toBe(29);
    expect(tableRowMinHeight(3)).toBe(61);
  });
});
