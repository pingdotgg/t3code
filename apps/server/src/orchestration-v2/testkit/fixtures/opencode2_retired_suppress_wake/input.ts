import { OPENCODE2_SUBAGENT_BACKGROUND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2RetiredSuppressWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_SUBAGENT_BACKGROUND_PROMPT },
      { type: "message", text: "Recover after retirement. Respond exactly RECOVERY_ONE" },
      { type: "message", text: "Recover after retired cancellation. Respond exactly RECOVERY_TWO" },
    ],
  };
}
