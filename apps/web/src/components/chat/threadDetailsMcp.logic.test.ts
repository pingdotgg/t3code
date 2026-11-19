import { describe, expect, it } from "vite-plus/test";
import { summarizeMcpCalls } from "./threadDetailsMcp.logic";

describe("MCP usage summary", () => {
  it("counts explicit server calls without conflating servers or ordinary tools", () => {
    expect(
      summarizeMcpCalls([
        { type: "dynamic_tool", toolName: "mcp__t3-code__html_render" },
        { type: "dynamic_tool", toolName: "mcp__alan__search" },
        { type: "dynamic_tool", toolName: "mcp__t3-code__preview_open" },
        { type: "command_execution", toolName: "mcp__alan__search" },
        { type: "dynamic_tool", toolName: "read_file" },
        { type: "dynamic_tool", toolName: null },
        { type: "dynamic_tool", toolName: "mcp__broken" },
        { type: "dynamic_tool", toolName: "mcp__alan__" },
      ]),
    ).toEqual([
      { server: "t3-code", calls: 2 },
      { server: "alan", calls: 1 },
    ]);
  });
});
