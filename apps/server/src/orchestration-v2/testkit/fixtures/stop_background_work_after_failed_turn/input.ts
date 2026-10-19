import type { OrchestratorFixtureInput } from "../shared.ts";

export const STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT =
  "Start the dev server in the background with `bun run dev` and keep it running.";

export function stopBackgroundWorkAfterFailedTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "stop_background_work", targetRunIndex: 1 },
    ],
  };
}

export function stopBackgroundWorkAfterReleaseInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "stop_background_work", targetRunIndex: 1 },
    ],
  };
}
