/**
 * Host-side steering for the product-native in-app browser when its MCP tools
 * exist. Codex already had this block. Grok and Cursor get it on the first
 * new-session prompt. Claude and OpenCode are not wired here: Claude uses a
 * preset system prompt, and OpenCode sessions on an external server skip mcp.add.
 */

export const HOST_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code in-app browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Aside (\`aside exec\`, \`aside repl\`, or the Aside MCP \`repl\` tool), Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;

export function prefixHostBrowserToolInstructions(
  userText: string,
  options: { readonly includeBrowserTools: boolean },
): string {
  if (!options.includeBrowserTools) return userText;
  const trimmed = userText.trim();
  const block = HOST_BROWSER_TOOL_INSTRUCTIONS.trim();
  return trimmed.length > 0 ? `${block}\n\n${trimmed}` : block;
}
