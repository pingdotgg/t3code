import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_BACKGROUND_SUBAGENT_PROMPT =
  "Spawn one background subagent (run it in the background, do not wait for it) whose task is: run the shell command 'sleep 20' and then reply exactly SUBAGENT_DONE. As soon as the subagent is launched, end your turn by replying exactly ROOT_DONE without waiting for it.";
export const GROK_BACKGROUND_SUBAGENT_QUEUED_PROMPT = "Reply exactly QUEUED_DONE.";
export const GROK_BACKGROUND_SUBAGENT_STEER_PROMPT = "Reply exactly STEER_DONE.";

/** Grok's own reply once the subagent finished (its `subagent-completed-<id>` wake turn). */
const GROK_SUBAGENT_WAKE_LABEL =
  "notification:session/update:agent_message_chunk:subagent-completed-00000000-0000-4000-8000-000000000002";

// The root prompt settles while the subagent still runs. Run 1 completes with
// its reply and the subagent carries over, so a message queued behind it
// starts at once (run 2), and a steer aimed at it starts a new turn (run 3)
// instead of superseding its finished reply. The queued and steered prompts
// are hand-written in the recorded Grok 1.0.41 shape between the subagent's
// own frames (#17159). Grok's reply to the finished subagent replays as a
// continuation run (run 4), like Claude and Codex background wakes.
export function grokBackgroundSubagentInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_BACKGROUND_SUBAGENT_PROMPT },
      { type: "queue_message", text: GROK_BACKGROUND_SUBAGENT_QUEUED_PROMPT },
      { type: "capture_shell_snapshot", key: "while-subagent-runs" },
      {
        type: "steer",
        text: GROK_BACKGROUND_SUBAGENT_STEER_PROMPT,
        targetRunIndex: 1,
        targetReplyFinished: true,
      },
      { type: "release_replay_gate", label: GROK_SUBAGENT_WAKE_LABEL },
      { type: "finish_held_run", targetRunIndex: 4, status: "completed" },
    ],
  };
}
