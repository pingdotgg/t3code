import { OPENCODE2_RETRY_UNKNOWN_FINISH_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2RetryUnknownFinishInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OPENCODE2_RETRY_UNKNOWN_FINISH_PROMPT }],
  };
}
