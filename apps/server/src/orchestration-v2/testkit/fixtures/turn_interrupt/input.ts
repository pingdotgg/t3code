import { TURN_INTERRUPT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function turnInterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TURN_INTERRUPT_PROMPT },
      { type: "interrupt", targetRunIndex: 1 },
    ],
  };
}
