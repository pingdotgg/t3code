import { OPENCODE2_SUBAGENT_BACKGROUND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2SubagentBackgroundWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_SUBAGENT_BACKGROUND_PROMPT },
      { type: "provider_continuation" },
    ],
  };
}
