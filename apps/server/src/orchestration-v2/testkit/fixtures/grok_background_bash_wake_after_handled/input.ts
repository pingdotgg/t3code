import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_WAKE_AFTER_HANDLED_LAST_LINE = "second done";

export const GROK_WAKE_AFTER_HANDLED_PROMPT =
  "Start two shell commands as background tasks (run them in the background, do not wait for them, do not use the Monitor tool). First: 'sleep 2; echo first done'. Second: 'sleep 25; echo second done'. Then read the first command's output with your tool for getting a background command's output, waiting for it to finish. Do not read or wait for the second command. Then end your turn by replying exactly ROOT_DONE. When the second command finishes, reply exactly with its last line.";

/** The first frame of Grok's own `task-completed-*` wake turn for the second command. */
const GROK_WAKE_AFTER_HANDLED_WAKE_LABEL =
  "notification:session/update:agent_thought_chunk:task-completed-00000000-0000-4000-8000-000000000003";

// The first command is read inside the root turn, so it counts as handled
// there. The second one ends after the root prompt settles, and Grok answers
// it in its own wake turn. That reply must reach the continuation run even
// though a different task was handled in the root turn.
export function grokBackgroundBashWakeAfterHandledInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_WAKE_AFTER_HANDLED_PROMPT },
      { type: "finish_held_run", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: GROK_WAKE_AFTER_HANDLED_WAKE_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
