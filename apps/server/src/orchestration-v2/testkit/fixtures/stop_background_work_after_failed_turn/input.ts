import type { OrchestratorFixtureInput } from "../shared.ts";

export const STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT =
  "Start the dev server in the background with `bun run dev` and keep it running.";

/**
 * An ACP agent's prompt fails while its command is still in progress. The
 * adapter ends the turn but not the command, so the thread keeps showing it
 * running. Its frames reuse the registry tool frames and Grok's recorded
 * prompt error (grok_prompt_error).
 */
export function stopBackgroundWorkAfterFailedTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "stop_background_work", targetRunIndex: 1 },
    ],
  };
}

/**
 * The same thread once the idle timeout released its provider session: no
 * process is left to tell, and Stop still clears what the thread shows.
 */
export function stopBackgroundWorkAfterReleaseInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "stop_background_work", targetRunIndex: 1 },
    ],
  };
}
