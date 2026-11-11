import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_BACKGROUND_BASH_TICKS = ["tock 1", "tock 2", "tock 3"] as const;

export const GROK_BACKGROUND_BASH_PROMPT =
  "Start this shell command as a background task (run it in the background, do not wait for it, do not use the Monitor tool): 'for i in 1 2 3; do sleep 8; echo tock $i; done'. As soon as it has started, end your turn by replying exactly ROOT_DONE. When it finishes, reply exactly with its last line.";

const GROK_BACKGROUND_BASH_WAKE_LABEL =
  "notification:session/update:agent_thought_chunk:task-completed-00000000-0000-4000-8000-000000000002";

export function grokBackgroundBashInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_BACKGROUND_BASH_PROMPT },
      { type: "finish_held_run", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: GROK_BACKGROUND_BASH_WAKE_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
