import { describe, expect, it } from "vite-plus/test";

import { toProviderContextUsage } from "./ClaudeContextUsage.ts";

describe("toProviderContextUsage", () => {
  it("maps categories and expandable groups from the SDK report", () => {
    const usage = toProviderContextUsage({
      model: "claude-opus-4",
      totalTokens: 60_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 30,
      gridRows: [],
      isAutoCompactEnabled: true,
      categories: [
        { name: "System tools", tokens: 19_200, kind: "used", color: "#4f8ef7" },
        { name: "Messages", tokens: 12_000, kind: "used", color: "#3fb27f" },
        { name: "Free space", tokens: 140_000, kind: "free", color: "#aaa" },
        {
          name: "MCP tools (deferred)",
          tokens: 42_400,
          kind: "deferred",
          isDeferred: true,
          color: "#f0783c",
        },
      ],
      systemPromptSections: [{ name: "claude_code_instructions", tokens: 800 }],
      systemTools: [{ name: "Bash", tokens: 1_200 }],
      mcpTools: [
        { name: "mcp__t3-code__t3_thread_list", serverName: "t3-code", tokens: 900 },
        { name: "bare_tool", serverName: "other", tokens: 100 },
      ],
      memoryFiles: [{ path: "/Users/me/t3code/AGENTS.md", type: "User", tokens: 400 }],
      skills: {
        totalSkills: 1,
        includedSkills: 1,
        tokens: 50,
        skillFrontmatter: [{ name: "test-t3-app", source: "project", tokens: 50 }],
      },
      agents: [{ agentType: "Explore", source: "plugin", tokens: 300 }],
      apiUsage: null,
    });

    expect(usage.model).toBe("claude-opus-4");
    expect(usage.totalTokens).toBe(60_000);
    expect(usage.maxTokens).toBe(200_000);
    expect(usage.categories).toEqual([
      { name: "System tools", tokens: 19_200, deferred: false, kind: "used" },
      { name: "Messages", tokens: 12_000, deferred: false, kind: "used" },
      { name: "Free space", tokens: 140_000, deferred: false, kind: "free" },
      { name: "MCP tools (deferred)", tokens: 42_400, deferred: true, kind: "deferred" },
    ]);
    expect(usage.groups.map((group) => group.label)).toEqual([
      "System prompt",
      "System tools",
      "MCP tools",
      "Memory files",
      "Skills",
      "Custom agents",
    ]);
    expect(usage.groups.find((group) => group.label === "MCP tools")?.items).toEqual([
      { name: "t3_thread_list", tokens: 900, detail: "t3-code" },
      { name: "bare_tool", tokens: 100, detail: "other" },
    ]);
    expect(usage.groups.find((group) => group.label === "Memory files")?.items).toEqual([
      { name: "t3code/AGENTS.md", tokens: 400, detail: "User" },
    ]);
  });
});
