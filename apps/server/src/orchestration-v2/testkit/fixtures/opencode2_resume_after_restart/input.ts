import {
  OPENCODE2_RESTART_PROMPT,
  OPENCODE2_RESTART_RECALL_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function openCode2ResumeAfterRestartInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_RESTART_PROMPT },
      { type: "message", text: OPENCODE2_RESTART_RECALL_PROMPT },
    ],
  };
}
