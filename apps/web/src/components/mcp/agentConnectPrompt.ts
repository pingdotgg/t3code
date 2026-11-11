/** Copy-paste prompts and CLI commands so Claude Code or Codex can connect T3 over MCP. */

export function claudeCodeMcpCommands(mcpUrl: string): readonly string[] {
  return [`claude mcp add --transport http t3 ${mcpUrl}`, "claude mcp login t3"];
}

export function codexMcpCommands(mcpUrl: string): readonly string[] {
  return [`codex mcp add t3 --url ${mcpUrl}`, "codex mcp login t3"];
}

export function claudeCodeConnectPrompt(mcpUrl: string): string {
  return [
    "Connect this T3 Code environment over MCP so you can use its tools from this session.",
    "Tell me what you will run before you change any MCP config, then:",
    "",
    ...claudeCodeMcpCommands(mcpUrl).map((command) => `- \`${command}\``),
    "",
    "If login opens a browser, wait for me to approve the sign-in page.",
    "If there is no browser, use `claude mcp login t3 --no-browser`, give me the URL, and paste the final URL back when asked.",
    "When `claude mcp list` shows `t3` as connected, try a read-only T3 tool such as `t3_project_list` in this session.",
    "If those tools are not available yet, tell me to reload or start a new Claude Code session, then confirm again.",
    "Only when a T3 tool works here, say you are ready and ask what I want to do in T3 Code.",
  ].join("\n");
}

export function codexConnectPrompt(mcpUrl: string): string {
  return [
    "Connect this T3 Code environment over MCP so you can use its tools from this session.",
    "Tell me what you will run before you change any MCP config, then:",
    "",
    ...codexMcpCommands(mcpUrl).map((command) => `- \`${command}\``),
    "",
    "If login opens a browser, wait for me to approve the sign-in page.",
    "If there is no browser, use `codex mcp login t3 --no-browser`, give me the URL, and paste the final URL back when asked.",
    "`codex mcp list` only shows configured servers; when it lists `t3` with OAuth, try a read-only T3 tool such as `t3_project_list` in this session.",
    "If those tools are not available yet, tell me to reload or start a new Codex session (or check `/mcp` for active servers), then confirm again.",
    "Only when a T3 tool works here, say you are ready and ask what I want to do in T3 Code.",
  ].join("\n");
}
