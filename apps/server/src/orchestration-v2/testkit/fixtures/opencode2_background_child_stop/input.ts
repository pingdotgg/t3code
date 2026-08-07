import { OPENCODE2_SUBAGENT_BACKGROUND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2BackgroundChildStopInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_SUBAGENT_BACKGROUND_PROMPT },
      {
        type: "interrupt_provider_native",
        subagentNativeItemId: "tool:call_opencode2_background_child_stop",
      },
      { type: "message", text: "Recover after cancellation. Respond exactly RECOVERY_OK" },
    ],
  };
}
