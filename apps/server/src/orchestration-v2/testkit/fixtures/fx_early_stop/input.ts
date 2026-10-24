import { SIMPLE_PROMPT, TURN_INTERRUPT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/**
 * Stop right after the prompt, then a follow-up. fx 0.0.13 answers the
 * prompt with stopReason cancelled, and the follow-up runs in the same fx
 * session. Both turns were recorded in one live session, not spliced.
 */
export function fxEarlyStopInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TURN_INTERRUPT_PROMPT },
      { type: "interrupt", targetRunIndex: 1 },
      { type: "message", text: SIMPLE_PROMPT },
    ],
  };
}
