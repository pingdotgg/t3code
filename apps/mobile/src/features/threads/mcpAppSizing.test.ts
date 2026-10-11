import { describe, expect, it } from "vite-plus/test";

import { mcpAppInlineHeight } from "./mcpAppSizing";

describe("inline MCP app height", () => {
  it.each([undefined, NaN, Infinity, -Infinity])(
    "ignores invalid or absent height %s",
    (height) => {
      expect(mcpAppInlineHeight(height)).toBeUndefined();
    },
  );

  it.each([
    [-10, 80],
    [0, 80],
    [149.6, 150],
    [420, 420],
    [2000, 420],
  ])("sizes content height %s within the inline viewport", (height, expected) => {
    expect(mcpAppInlineHeight(height)).toBe(expected);
  });
});
