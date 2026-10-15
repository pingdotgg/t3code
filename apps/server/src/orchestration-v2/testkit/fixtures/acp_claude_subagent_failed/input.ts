import type { OrchestratorFixtureInput } from "../shared.ts";

import { ACP_CLAUDE_BACKGROUND_REPLY_PROMPT } from "../acp_claude_background_reply/input.ts";

// Claude Agent on ACP v2. A background subagent fails, and Claude supplies the
// failure text later. Claude's follow-up waits until a run showed that text.
export function acpClaudeSubagentFailedInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_BACKGROUND_REPLY_PROMPT },
      { type: "release_replay_gate", label: "child.progress" },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
      { type: "release_replay_gate", label: "followup.running" },
      { type: "await_run_status", targetRunIndex: 3, status: "completed" },
    ],
  };
}
