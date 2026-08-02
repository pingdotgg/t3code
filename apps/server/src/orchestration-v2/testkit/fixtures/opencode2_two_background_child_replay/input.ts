import {
  OPENCODE2_TWO_COMPLETED_SUBAGENT_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function openCode2TwoBackgroundChildReplayInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_TWO_COMPLETED_SUBAGENT_PROMPT },
      { type: "provider_continuation" },
      { type: "provider_continuation" },
    ],
  };
}
