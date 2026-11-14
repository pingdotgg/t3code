import { TURN_INTERRUPT_MID_TOOL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function turnInterruptMidToolInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TURN_INTERRUPT_MID_TOOL_PROMPT },
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
    ],
  };
}

/** Kiro lists a command as pending before it runs, so Stop waits until it is running. */
export function turnInterruptMidToolKiroInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TURN_INTERRUPT_MID_TOOL_PROMPT },
      {
        type: "interrupt",
        targetRunIndex: 1,
        waitForTurnItemType: "command_execution",
        waitForTurnItemStatus: "running",
      },
    ],
  };
}
