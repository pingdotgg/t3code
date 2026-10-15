import type { OrchestratorFixtureInput } from "../shared.ts";

export const ACP_CLAUDE_BACKGROUND_REPLY_PROMPT =
  "Start a background subagent that waits, then tell me when it is done.";

/** The subagent's first output, after the turn already reported idle. */
const ACP_CLAUDE_BACKGROUND_PROGRESS_LABEL = "child.progress";

// Claude Agent on ACP v2 (#17203): the turn reports idle at its result while
// its background subagent runs on in its own child session. The subagent's
// output is held until run 1 settled, then streams into its child thread, and
// Claude's own follow-up cycle replays as a continuation.
export function acpClaudeBackgroundReplyInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_BACKGROUND_REPLY_PROMPT },
      { type: "release_replay_gate", label: ACP_CLAUDE_BACKGROUND_PROGRESS_LABEL },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
