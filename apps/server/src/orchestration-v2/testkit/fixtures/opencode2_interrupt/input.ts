import { OPENCODE2_INTERRUPT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2InterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_INTERRUPT_PROMPT },
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
    ],
  };
}
