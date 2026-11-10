import { TOOL_CALL_READ_ONLY_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function toolCallReadOnlyInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: TOOL_CALL_READ_ONLY_PROMPT }],
  };
}
