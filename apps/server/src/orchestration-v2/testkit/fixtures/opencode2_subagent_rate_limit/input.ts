import { OPENCODE2_SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2SubagentRateLimitInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OPENCODE2_SUBAGENT_PROMPT }],
  };
}
