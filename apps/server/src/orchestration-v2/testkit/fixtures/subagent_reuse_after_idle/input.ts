import {
  SUBAGENT_REUSE_AFTER_IDLE_PROMPT,
  SUBAGENT_REUSE_AFTER_IDLE_RESUME_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/**
 * Regression for subagent reuse across a session reap.
 *
 * Adapters track spawned subagents in a process-local map, so the reaper
 * releasing the session runtime wipes every identity it knows about. Without
 * rehydrating them from the projection, the returning agent thread is
 * unrecognised on the next turn and gets registered as a brand new subagent —
 * the user sees a duplicate appear and the original frozen forever.
 *
 */
export function subagentReuseAfterIdleInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: SUBAGENT_REUSE_AFTER_IDLE_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: SUBAGENT_REUSE_AFTER_IDLE_RESUME_PROMPT },
    ],
  };
}
