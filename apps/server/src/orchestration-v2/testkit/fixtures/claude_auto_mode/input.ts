import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_AUTO_MODE_PROMPT = `Use the Write tool once to create auto-mode-fixture.txt containing exactly: auto mode fixture. Then reply exactly: auto mode fixture written. Do not read any files, use the shell, network, or MCP.`;

export function claudeAutoModeInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "auto",
    steps: [{ type: "message", text: CLAUDE_AUTO_MODE_PROMPT }],
  };
}
