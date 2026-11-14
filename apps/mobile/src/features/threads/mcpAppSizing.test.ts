import { describe, expect, it } from "vite-plus/test";

import { MCP_APP_INLINE_MAX_HEIGHT, mcpAppInlineHeight } from "./mcpAppSizing";

describe("mcpAppInlineHeight", () => {
  it("leaves inline sizing unchanged without a finite height report", () => {
    for (const height of [undefined, Number.NaN, Infinity, -Infinity]) {
      expect(mcpAppInlineHeight(height)).toBeUndefined();
    }
  });

  it("caps inline apps below the shared fullscreen limit", () => {
    expect(mcpAppInlineHeight(421)).toBe(MCP_APP_INLINE_MAX_HEIGHT);
    expect(mcpAppInlineHeight(3000)).toBe(MCP_APP_INLINE_MAX_HEIGHT);
  });
});
