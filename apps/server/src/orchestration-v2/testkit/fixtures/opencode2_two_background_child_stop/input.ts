import {
  OPENCODE2_TWO_SUBAGENT_BACKGROUND_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function openCode2TwoBackgroundChildStopInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_TWO_SUBAGENT_BACKGROUND_PROMPT },
      {
        type: "interrupt_provider_native",
        subagentNativeItemId: "tool:call_opencode2_two_background_child_stop_cancel",
      },
      { type: "provider_continuation" },
    ],
  };
}
