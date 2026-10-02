import { OPENCODE2_INTERRUPT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2InterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_INTERRUPT_PROMPT },
      // Stop lands once the shell call is running, as in the recording.
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
    ],
  };
}
