import { OPENCODE_SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCodeSubagentInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OPENCODE_SUBAGENT_PROMPT }],
  };
}
