import { describe, expect, it } from "vite-plus/test";

import {
  deriveToolIdentityFromData,
  parseToolIdentity,
  summarizeToolArguments,
} from "./toolIdentity.ts";

describe("parseToolIdentity", () => {
  it("splits canonical MCP names into server and tool", () => {
    expect(parseToolIdentity("mcp__cloudflare__docs")).toEqual({
      family: "mcp",
      toolName: "mcp__cloudflare__docs",
      displayName: "Cloudflare · Docs",
      provider: "Cloudflare",
      action: "Docs",
    });
  });

  it("humanizes multi-word MCP servers and snake_case tools", () => {
    expect(parseToolIdentity("mcp__claude_ai_Gmail__get_message")).toMatchObject({
      family: "mcp",
      provider: "Claude Ai Gmail",
      action: "Get message",
      displayName: "Claude Ai Gmail · Get message",
    });
  });

  it("keeps MCP tools whose name contains 'agent' in the MCP family", () => {
    expect(parseToolIdentity("mcp__linear__agent_session_create").family).toBe("mcp");
  });

  it("treats an MCP server without a tool segment as an MCP call", () => {
    expect(parseToolIdentity("mcp__cloudflare")).toMatchObject({
      family: "mcp",
      provider: "Cloudflare",
      displayName: "Cloudflare",
    });
  });

  it("resolves the skill name from the Skill tool input", () => {
    expect(parseToolIdentity("Skill", { skill: "deep-research" })).toEqual({
      family: "skill",
      toolName: "Skill",
      displayName: "Skill · deep-research",
      action: "deep-research",
    });
  });

  it("attributes plugin-namespaced skills to their plugin", () => {
    expect(parseToolIdentity("Skill", { skill: "caveman:cavecrew" })).toMatchObject({
      family: "skill",
      provider: "caveman",
      action: "cavecrew",
      displayName: "Skill · caveman:cavecrew",
    });
  });

  it("falls back to a bare Skill label when the input has no skill name", () => {
    expect(parseToolIdentity("Skill", {})).toEqual({
      family: "skill",
      toolName: "Skill",
      displayName: "Skill",
    });
  });

  it("labels computer-use calls with their action", () => {
    expect(parseToolIdentity("computer", { action: "screenshot" })).toEqual({
      family: "computer_use",
      toolName: "computer",
      displayName: "Computer use · Screenshot",
      action: "Screenshot",
    });
  });

  it("routes computer-use MCP servers to the computer-use family", () => {
    expect(parseToolIdentity("mcp__computer-use__click")).toMatchObject({
      family: "computer_use",
      provider: "Computer Use",
    });
  });

  it("leaves built-in tools untouched", () => {
    expect(parseToolIdentity("Bash")).toEqual({
      family: "builtin",
      toolName: "Bash",
      displayName: "Bash",
    });
  });
});

describe("deriveToolIdentityFromData", () => {
  it("prefers an identity the adapter already resolved", () => {
    expect(
      deriveToolIdentityFromData({
        tool: { family: "skill", toolName: "Skill", displayName: "Skill · verify" },
      }),
    ).toMatchObject({ family: "skill", displayName: "Skill · verify" });
  });

  it("derives an identity from a Claude-shaped data blob", () => {
    expect(
      deriveToolIdentityFromData({ toolName: "Skill", input: { skill: "dataviz" } }),
    ).toMatchObject({ family: "skill", action: "dataviz" });
  });

  it("derives an identity from Codex structural MCP fields", () => {
    expect(
      deriveToolIdentityFromData({ item: { server: "cloudflare", tool: "search" } }),
    ).toMatchObject({ family: "mcp", provider: "Cloudflare", action: "Search" });
  });

  it("returns undefined for built-in tools and unknown shapes", () => {
    expect(deriveToolIdentityFromData({ toolName: "Bash", input: {} })).toBeUndefined();
    expect(deriveToolIdentityFromData({ nothing: true })).toBeUndefined();
    expect(deriveToolIdentityFromData(undefined)).toBeUndefined();
  });
});

describe("summarizeToolArguments", () => {
  it("renders scalar arguments as key=value pairs", () => {
    expect(summarizeToolArguments({ query: "workers kv", max_results: 5, deep: true })).toBe(
      "query=workers kv, max_results=5, deep=true",
    );
  });

  it("collapses structured values and truncates long summaries", () => {
    expect(summarizeToolArguments({ files: ["a", "b"], options: { a: 1 } })).toBe(
      "files=[2], options={…}",
    );
    expect(summarizeToolArguments({ query: "x".repeat(40) }, 20)).toBe(`query=${"x".repeat(13)}…`);
  });

  it("returns undefined when there is nothing to show", () => {
    expect(summarizeToolArguments({})).toBeUndefined();
    expect(summarizeToolArguments(undefined)).toBeUndefined();
  });
});
