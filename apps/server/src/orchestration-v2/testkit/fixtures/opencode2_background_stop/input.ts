import { OPENCODE2_BACKGROUND_STOP_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2BackgroundStopInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_BACKGROUND_STOP_PROMPT },
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
    ],
  };
}
