import type { OrchestratorFixtureInput } from "../shared.ts";

import { ACP_CLAUDE_BACKGROUND_REPLY_PROMPT } from "../acp_claude_background_reply/input.ts";

// Claude Agent on ACP v2. The foreground fails while its background subagent
// runs on. Claude's follow-up is held until the subagent's run showed it.
export function acpClaudeFailedPromptBackgroundSubagentInput(): OrchestratorFixtureInput {
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
