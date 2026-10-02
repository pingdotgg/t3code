import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_BACKGROUND_SUBAGENT_PROMPT =
  "Spawn one background subagent (run it in the background, do not wait for it) whose task is: run the shell command 'sleep 20' and then reply exactly SUBAGENT_DONE. As soon as the subagent is launched, end your turn by replying exactly ROOT_DONE without waiting for it.";

/** Grok's own reply once the subagent finished (its `subagent-completed-<id>` wake turn). */
const GROK_SUBAGENT_WAKE_LABEL =
  "notification:session/update:agent_message_chunk:subagent-completed-00000000-0000-4000-8000-000000000002";

// The root prompt settles while the subagent still runs, so run 1 is held open
// until `subagent_finished`, then finishes through the adapter's debounce.
// Grok's own reply to the finished subagent is held until run 1 settled and
// replays as a continuation run, like Claude and Codex background wakes.
export function grokBackgroundSubagentInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_BACKGROUND_SUBAGENT_PROMPT },
      { type: "finish_held_run", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: GROK_SUBAGENT_WAKE_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
