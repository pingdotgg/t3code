import { OPENCODE2_SUBAGENT_BACKGROUND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2AmbiguousExecutionWakesInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_SUBAGENT_BACKGROUND_PROMPT },
      {
        type: "message",
        text: "Recover after an ambiguous execution. Respond exactly RECOVERY_OK",
      },
    ],
  };
}
