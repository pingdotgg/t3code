import { describe, expect, it } from "vite-plus/test";
import { formatThreadFindCount, stepThreadFindIndex } from "./threadFind";

describe("thread find navigation", () => {
  it("clamps, wraps, and formats positions", () => {
    expect(stepThreadFindIndex(2, 3, 1)).toBe(0);
    expect(stepThreadFindIndex(0, 3, -1)).toBe(2);
    expect(formatThreadFindCount(4, 2)).toBe("2/2");
    expect(formatThreadFindCount(0, 0)).toBe("0/0");
  });
});
