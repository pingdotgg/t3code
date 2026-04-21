import { type OrchestratorFixtureInput } from "../shared.ts";

const TOOL_CALL_WRITE_PROMPT =
  "Create or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.";

export function toolCallWorkspaceNeverInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: TOOL_CALL_WRITE_PROMPT }],
  };
}
