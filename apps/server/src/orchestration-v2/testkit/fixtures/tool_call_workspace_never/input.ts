import { TOOL_CALL_WRITE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function toolCallWorkspaceNeverInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: TOOL_CALL_WRITE_PROMPT }],
  };
}
