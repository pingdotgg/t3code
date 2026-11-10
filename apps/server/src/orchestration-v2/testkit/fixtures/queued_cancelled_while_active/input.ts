import {
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export const ACTIVE_RUN_SHELL_SNAPSHOT_KEY = "active-run-over-cancelled-latest";

export function queuedCancelledWhileActiveInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: MULTI_TURN_FIRST_PROMPT },
      {
        type: "queue_message",
        text: MULTI_TURN_SECOND_PROMPT,
        createdBy: "agent",
        creationSource: "server",
      },
      { type: "cancel_queued_run", targetRunIndex: 2 },
      { type: "await_run_status", targetRunIndex: 1, status: "running" },
      { type: "capture_shell_snapshot", key: ACTIVE_RUN_SHELL_SNAPSHOT_KEY },
      { type: "release_replay_gate", label: "turn/completed" },
    ],
  };
}
