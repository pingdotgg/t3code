import type { OrchestratorFixtureInput } from "../shared.ts";

const ACP_CLAUDE_BACKGROUND_APPROVAL_PROMPT = "Start a background subagent that runs a command.";

// Claude Agent on ACP v2 with approvals on. Run 1 ends at its idle, then the
// background subagent asks to run a command while no run is active. The ask
// opens a continuation run that shows it; the user approves, and the subagent
// carries on. Claude then follows up on its own.
export function acpClaudeBackgroundApprovalInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: ACP_CLAUDE_BACKGROUND_APPROVAL_PROMPT },
      { type: "approve_next_runtime_request" },
      { type: "await_run_status", targetRunIndex: 3, status: "completed" },
    ],
  };
}
