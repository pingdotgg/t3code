import { OPENCODE_BACKGROUND_WAKE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCodeBackgroundWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE_BACKGROUND_WAKE_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
