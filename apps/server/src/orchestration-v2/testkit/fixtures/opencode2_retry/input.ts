import { OPENCODE2_RETRY_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2RetryInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OPENCODE2_RETRY_PROMPT }],
  };
}
