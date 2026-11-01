import type { OrchestratorFixtureInput } from "../shared.ts";

export const STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT =
  "Start the dev server in the background with `bun run dev` and keep it running.";

export function stopBackgroundWorkAfterFailedTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "capture_shell_snapshot", key: "after-exit" },
    ],
  };
}

export function stopBackgroundWorkAfterReleaseInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "capture_shell_snapshot", key: "after-exit" },
    ],
  };
}
