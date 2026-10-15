import type { OrchestratorFixtureInput } from "../shared.ts";
import { ACP_CLAUDE_SUBAGENT_RESUME_PROMPT } from "../acp_claude_subagent_resume/input.ts";

// Claude Agent on ACP v2. A background subagent goes idle with a tool still
// open, and Claude's own cycle (run 2) resumes it. Run 2 and the resumed
// subagent both end before the tool's completion arrives, then Claude follows
// up (run 3).
export function acpClaudeSubagentResumeLateToolInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_SUBAGENT_RESUME_PROMPT },
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: "cycle.running" },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
      { type: "release_replay_gate", label: "child.tool.done" },
      { type: "await_run_status", targetRunIndex: 3, status: "completed" },
    ],
  };
}
