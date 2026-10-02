import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_MONITOR_TICKS = ["tick 1", "tick 2", "tick 3"] as const;

export const GROK_MONITOR_PROMPT =
  "Use the Monitor tool to watch this command: 'for i in 1 2 3; do sleep 8; echo tick $i; done'. Do not wait for the monitor to finish; as soon as it has started, end your turn by replying exactly ROOT_DONE.";

/** First reply Grok streams after the monitor ended (its own `notifications-*` wake turn). */
const GROK_MONITOR_WAKE_LABEL =
  "notification:session/update:agent_message_chunk:notifications-01a0d754-c2a6-7e51-b5d9-710c43051847";

// The root prompt settles while the monitor still runs, so run 1 is held open
// until `_x.ai/task_completed`, then finishes through the adapter's debounce.
// Grok's own reply to the finished monitor is held until run 1 settled and
// replays as a continuation run, like Claude and Codex background wakes.
export function grokMonitorInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_MONITOR_PROMPT },
      { type: "finish_held_run", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: GROK_MONITOR_WAKE_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
