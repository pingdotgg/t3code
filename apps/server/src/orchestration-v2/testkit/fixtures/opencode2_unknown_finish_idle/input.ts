import { OPENCODE2_UNKNOWN_FINISH_IDLE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2UnknownFinishIdleInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OPENCODE2_UNKNOWN_FINISH_IDLE_PROMPT }],
  };
}
