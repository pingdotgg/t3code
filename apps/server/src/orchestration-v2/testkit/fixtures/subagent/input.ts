import { SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function subagentInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: SUBAGENT_PROMPT }],
  };
}
