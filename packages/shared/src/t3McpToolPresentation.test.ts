import { describe, expect, it } from "vite-plus/test";

import { resolveT3McpToolPresentation } from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("pretty prints Claude and Cursor T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("mcp__t3-code__t3_thread_read")).toEqual({
      displayName: "Read a T3 thread",
      logo: "t3-code",
    });
  });

  it("pretty prints Codex T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("t3-code.create_threads")).toEqual({
      displayName: "Create T3 threads",
      logo: "t3-code",
    });
  });

  it("pretty prints bare T3 MCP toolkit names", () => {
    expect(resolveT3McpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t3-code",
    });
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveT3McpToolPresentation("mcp__github__search_issues")).toBeNull();
  });
});
