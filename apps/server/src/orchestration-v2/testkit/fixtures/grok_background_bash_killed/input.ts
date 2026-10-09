import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_BACKGROUND_BASH_KILLED_PROMPT =
  "Start the log search and the second step in the background. Stop the log search, then reply exactly ROOT_DONE.";

/** The first frame of Grok's own `task-completed-call-*` wake turn: it polls the finished command. */
const GROK_BACKGROUND_BASH_KILLED_WAKE_LABEL =
  "notification:session/update:tool_call:task-completed-call-33333333-3333-4333-8333-333333333333-2";

// The first command ends in the turn with a Grok 1.0.46 `KillTask` and no
// `task_completed`, so the kill result alone must end it. The second command
// outlives the turn and holds run 1 until its `task_completed`; Grok's own
// reply to it is a continuation run.
export function grokBackgroundBashKilledInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_BACKGROUND_BASH_KILLED_PROMPT },
      { type: "finish_held_run", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: GROK_BACKGROUND_BASH_KILLED_WAKE_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
