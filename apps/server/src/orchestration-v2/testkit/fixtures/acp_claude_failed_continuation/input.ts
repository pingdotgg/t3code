import type { OrchestratorFixtureInput } from "../shared.ts";

const ACP_CLAUDE_FAILED_CONTINUATION_PROMPT = "Start a background subagent that waits.";

// Claude Agent on ACP v2. Run 1 ends at its idle while a background subagent
// runs. Once it finishes, Claude's own follow-up cycle fails. That cycle's
// frames, its failed idle included, usually arrive before the continuation
// run that shows them attaches.
export function acpClaudeFailedContinuationInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_FAILED_CONTINUATION_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "failed" },
    ],
  };
}
