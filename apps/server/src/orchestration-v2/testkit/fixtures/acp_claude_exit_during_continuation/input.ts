import type { OrchestratorFixtureInput } from "../shared.ts";

const ACP_CLAUDE_EXIT_DURING_CONTINUATION_PROMPT = "Start a background subagent that waits.";

// Claude Agent on ACP v2. Run 1 ends at its idle while a background subagent
// runs. Claude then starts a cycle of its own (run 2), and its process exits
// partway through that cycle.
export function acpClaudeExitDuringContinuationInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_EXIT_DURING_CONTINUATION_PROMPT },
      {
        type: "await_run_status",
        targetRunIndex: 2,
        status: "running",
        waitForTurnItemType: "dynamic_tool",
      },
      { type: "release_replay_gate", label: "cycle.more" },
      { type: "await_run_status", targetRunIndex: 2, status: "failed" },
    ],
  };
}
