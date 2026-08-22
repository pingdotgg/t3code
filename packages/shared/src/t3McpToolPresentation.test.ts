import { describe, expect, it } from "vite-plus/test";

import {
  extractOpenCode2ExecuteT3McpToolName,
  resolveT3McpToolPresentation,
} from "./t3McpToolPresentation.ts";

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

  it("pretty prints Grok ACP T3 MCP tool names", () => {
    // Grok ACP reports server__tool without the Claude-style mcp__ prefix.
    expect(resolveT3McpToolPresentation("t3-code__t3_thread_start")).toEqual({
      displayName: "Start a T3 thread",
      logo: "t3-code",
    });
    expect(resolveT3McpToolPresentation("t3-code__delegate_task")).toEqual({
      displayName: "Delegate a child task",
      logo: "t3-code",
    });
    expect(resolveT3McpToolPresentation("t3-code__task_status")).toEqual({
      displayName: "Get delegated task status",
      logo: "t3-code",
    });
  });

  it("pretty prints bare T3 MCP toolkit names", () => {
    expect(resolveT3McpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t3-code",
    });
  });

  it("pretty prints worktree T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("mcp__t3-code__t3_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "t3-code",
    });
    expect(resolveT3McpToolPresentation("t3-code.t3_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "t3-code",
    });
  });

  it("pretty prints preview T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("T3-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "t3-code",
    });
    expect(resolveT3McpToolPresentation("mcp__t3-code__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "t3-code",
    });
  });

  it("pretty prints OpenCode 2 execute-bridged T3 MCP tool names", () => {
    const code = `
const result = await tools["t3-code"].t3_thread_start({
  prompt: "Say: test 1",
});
return JSON.stringify(result);
`;
    expect(
      resolveT3McpToolPresentation("execute", {
        input: { code },
      }),
    ).toEqual({
      displayName: "Start a T3 thread",
      logo: "t3-code",
    });
    expect(
      extractOpenCode2ExecuteT3McpToolName(
        `await tools['t3-code']['orchestrator_capabilities']({});`,
      ),
    ).toBe("orchestrator_capabilities");
    expect(
      extractOpenCode2ExecuteT3McpToolName(
        `await tools["t3-code"]["task_cancel"]({}); await tools["t3-code"].task_status({});`,
      ),
    ).toBe("task_cancel");
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveT3McpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(
      resolveT3McpToolPresentation("execute", {
        input: { code: `await tools["github"].search({})` },
      }),
    ).toBeNull();
  });
});
