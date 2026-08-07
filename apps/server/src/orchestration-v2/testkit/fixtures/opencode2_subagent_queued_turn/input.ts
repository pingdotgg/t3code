import {
  MULTI_TURN_SECOND_PROMPT,
  OPENCODE2_SUBAGENT_BACKGROUND_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function openCode2SubagentQueuedTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_SUBAGENT_BACKGROUND_PROMPT },
      { type: "queue_message", text: MULTI_TURN_SECOND_PROMPT },
      { type: "provider_continuation" },
    ],
  };
}
