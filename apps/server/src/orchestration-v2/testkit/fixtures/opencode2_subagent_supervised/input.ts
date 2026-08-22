import { OPENCODE2_SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2SubagentSupervisedInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_SUBAGENT_PROMPT },
      { type: "approve_next_runtime_request", decision: "accept" },
    ],
  };
}
