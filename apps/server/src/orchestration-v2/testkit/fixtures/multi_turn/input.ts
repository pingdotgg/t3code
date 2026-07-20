import {
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function multiTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: MULTI_TURN_FIRST_PROMPT },
      { type: "message", text: MULTI_TURN_SECOND_PROMPT },
    ],
  };
}
