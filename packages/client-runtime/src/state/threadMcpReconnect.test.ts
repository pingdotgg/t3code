import { describe, expect, it } from "vite-plus/test";

import { isReconnectMcpCommand } from "./threadMcpReconnect.ts";

describe("isReconnectMcpCommand", () => {
  it("recognizes a standalone reconnect command", () => {
    expect(isReconnectMcpCommand(" /RECONNECT-MCP ")).toBe(true);
  });

  it("does not consume prompts that merely start with the command", () => {
    expect(isReconnectMcpCommand("/reconnect-mcp after this turn")).toBe(false);
  });
});
