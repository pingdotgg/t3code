import type { OrchestratorFixtureInput } from "../shared.ts";

const ACP_CLAUDE_STOP_BACKGROUND_SUBAGENT_PROMPT = "Run a long command in a background subagent.";

// Claude Agent on ACP v2. Run 1 ends while its background subagent runs a
// long command, and the user stops that background work. Stop reaches Claude
// as session/close (the replay holds the frame after Claude's answer until
// Stop sent it).
export function acpClaudeStopBackgroundSubagentInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_STOP_BACKGROUND_SUBAGENT_PROMPT },
      { type: "stop_background_work", targetRunIndex: 1 },
      { type: "release_replay_gate", label: "child.after-close" },
    ],
  };
}
