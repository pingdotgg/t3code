import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_BACKGROUND_BASH_UNPOLLED_PROMPT =
  "Warm the cache in the background without waiting for it, then reply exactly ROOT_DONE.";

// The command ends while the turn is still open, and its `task_completed` is
// the only end signal: the agent never polls it. Grok then wakes itself with a
// `task-completed-call-*` turn after the root turn, which is a continuation run.
export function grokBackgroundBashUnpolledInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_BACKGROUND_BASH_UNPOLLED_PROMPT },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
