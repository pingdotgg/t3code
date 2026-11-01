import {
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  TURN_INTERRUPT_RECOVERY_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function turnInterruptRestartInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TURN_INTERRUPT_MID_TOOL_PROMPT },
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
      { type: "message", text: TURN_INTERRUPT_RECOVERY_PROMPT },
    ],
  };
}
