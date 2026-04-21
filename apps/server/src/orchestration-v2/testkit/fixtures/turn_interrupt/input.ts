import { type OrchestratorFixtureInput } from "../shared.ts";

const TURN_INTERRUPT_PROMPT =
  "Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.";

export function turnInterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TURN_INTERRUPT_PROMPT },
      { type: "interrupt", targetRunIndex: 1 },
    ],
  };
}
