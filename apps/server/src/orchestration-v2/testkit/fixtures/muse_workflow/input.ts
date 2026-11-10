import type { OrchestratorFixtureInput } from "../shared.ts";

const MUSE_WORKFLOW_PROMPT =
  "Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it.";

export function museWorkflowInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: MUSE_WORKFLOW_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
