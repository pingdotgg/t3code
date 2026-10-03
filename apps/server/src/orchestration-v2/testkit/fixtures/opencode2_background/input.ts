import { OPENCODE2_BACKGROUND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/**
 * The parent's turn ends while its background subagent runs. When the
 * subagent ends, OpenCode starts a parent execution of its own, which T3
 * replays as a continuation run.
 */
export function openCode2BackgroundInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_BACKGROUND_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
