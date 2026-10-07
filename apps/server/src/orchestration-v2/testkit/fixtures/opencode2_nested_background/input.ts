import { OPENCODE2_NESTED_BACKGROUND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/**
 * The thread's turn ends while a foreground subagent's own background
 * subagent still runs. The run completes only once that one has reported
 * back to the subagent that started it.
 */
export function openCode2NestedBackgroundInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_NESTED_BACKGROUND_PROMPT },
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
    ],
  };
}
