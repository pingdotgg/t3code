import { describe, expect, it } from "vite-plus/test";

import {
  claudeCodeConnectPrompt,
  claudeCodeMcpCommands,
  codexConnectPrompt,
  codexMcpCommands,
} from "./agentConnectPrompt";

const MCP_URL = "https://prod-a1.t3coderelay.com/mcp?x=1";

describe("agent connect prompts", () => {
  it("embeds the MCP URL in Claude Code and Codex commands", () => {
    expect(claudeCodeMcpCommands(MCP_URL)).toEqual([
      `claude mcp add --transport http t3 ${MCP_URL}`,
      "claude mcp login t3",
    ]);
    expect(codexMcpCommands(MCP_URL)).toEqual([
      `codex mcp add t3 --url ${MCP_URL}`,
      "codex mcp login t3",
    ]);
  });

  it("gives each agent a pasteable prompt with add, login, and confirm steps", () => {
    const claude = claudeCodeConnectPrompt(MCP_URL);
    expect(claude).toContain(MCP_URL);
    expect(claude).toContain("claude mcp add --transport http t3");
    expect(claude).toContain("claude mcp login t3");
    expect(claude).toContain("--no-browser");
    expect(claude).toContain("claude mcp list");
    expect(claude).toContain("t3_project_list");
    expect(claude).toContain("reload");

    const codex = codexConnectPrompt(MCP_URL);
    expect(codex).toContain(MCP_URL);
    expect(codex).toContain("codex mcp add t3 --url");
    expect(codex).toContain("codex mcp login t3");
    expect(codex).toContain("--no-browser");
    expect(codex).toContain("codex mcp list");
    expect(codex).toContain("configured servers");
    expect(codex).toContain("t3_project_list");
    expect(codex).toContain("reload");
  });
});
