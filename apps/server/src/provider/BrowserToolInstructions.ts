export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `## T3 Code collaborative browser

- MCP boundary: \`t3-code\` is the collaborative browser automation server. Use the canonical browser tools there: \`preview_preflight\`, \`preview_open\`, \`preview_open_and_snapshot\`, \`preview_tabs\`, \`preview_status\`, \`preview_navigate\`, \`preview_snapshot\`, \`preview_click\`, \`preview_type\`, and the related \`preview_*\` tools.
- For ordinary browser work, call \`preview_status\` first. For pairing or reconnect work, \`preview_preflight\` is the required first call because it distinguishes a closed tab, unsupported browser, invalid MCP credential, and target readiness.
- Before opening or navigating a pairing URL, call \`preview_preflight\` once with that URL (or its environment-port target). It probes only the token-free T3 environment descriptor, never consumes the pairing token, and returns typed browser, MCP credential, target, environment, and recovery state.
- When the intended target environment ID is known separately from the MCP host, pass it as \`expectedEnvironmentId\`; do not assume the MCP host's environment identity is the pairing target's identity.
- Treat \`open-browser\`, \`reconnect-required\`, \`configure-target\`, \`resolve-environment-mismatch\`, \`retry-browser\`, and \`use-supported-browser\` as actionable blocked states; do not retry pairing blindly or conclude that pairing failed from a generic navigation error.
- If preflight reports no attached tab, call \`preview_preflight({open:true, url:<same-target>})\` (or repeat the original preflight with the same \`target\` after \`preview_open\`); do not drop the target while opening a tab. A closed tab is different from an unsupported browser. Complete this recovery before concluding that the browser is unavailable. If an MCP tool returns \`invalid_mcp_credential\` with \`reconnect-required\`, restart the chat/session before retrying.
- Prefer \`preview_open_and_snapshot\` when starting on a page, environment-port targets for local dev servers, snapshot-provided semantic locators over coordinates, and focused interaction tools over page-wide JavaScript.
- For an authorized managed local T3 target, the desktop automatically reuses the selected browser profile or establishes a restricted preview session. Never ask for, print, or paste pairing credentials. If access is revoked or pairing is explicitly required, stop and report the failure instead of retrying authorization. Ordinary websites keep their normal login flow.
- Validate browser behavior from the final snapshot, visible page state, console errors, and failed network requests. Use \`preview_recording_start\` and \`preview_recording_stop\` for motion or timing evidence, but do not treat a recording alone as proof that the behavior is correct.
- Do not switch to a global browser skill, Chrome, standalone Playwright, or another browser system merely because the preview starts closed or the first call fails. Use an alternative only when \`t3-code\` is absent, the user explicitly requests it, or \`preview_open\` returns an explicit unsupported or unavailable error.
- For user-visible web changes, follow the repository's integrated product validation requirements: run one real-client pass, capture a final screenshot, and include relevant evidence in the handoff or pull request. Keep pairing tokens and credentials out of screenshots and recordings.
- Never use the legacy \`t3-tools\` preview stubs (\`preview_screenshot\`, \`preview_click\`, \`preview_type\`, \`preview_annotate\`) when \`t3-code\` is available.
- If a \`t3-code\` browser tool fails with \`401\` and \`www-authenticate: Bearer\`, its per-session MCP credential is invalid or expired. Restart the chat/session to reconnect browser automation.
- When a \`t3-code\` browser tool is deferred, search \`t3-code\` for the needed \`preview_*\` function before calling it. Do not use an MCP resources/list result as an availability check.
`;

export function buildBrowserToolInstructions(browserToolsAvailable: boolean): string {
  return browserToolsAvailable ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "";
}
