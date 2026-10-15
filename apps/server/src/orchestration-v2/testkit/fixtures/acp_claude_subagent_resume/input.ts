import type { OrchestratorFixtureInput } from "../shared.ts";

export const ACP_CLAUDE_SUBAGENT_RESUME_PROMPT = "Find the flaky test in the background.";

// Claude Agent on ACP v2. A background subagent finishes, and Claude's own
// cycle (run 2) resumes it with SendMessage, which reuses its child session.
// Run 2 ends while the resumed subagent works on (its work is held until
// then), and Claude follows up once it finished (run 3). The user renames the
// subagent's thread before Claude's cycle resumes it.
export const ACP_CLAUDE_SUBAGENT_RESUME_THREAD_TITLE = "Flaky test hunt";

export function acpClaudeSubagentResumeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_SUBAGENT_RESUME_PROMPT },
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      {
        type: "rename_subagent_thread",
        nativeTaskId: "toolu_agent_1",
        title: ACP_CLAUDE_SUBAGENT_RESUME_THREAD_TITLE,
      },
      { type: "release_replay_gate", label: "cycle.running" },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
      { type: "release_replay_gate", label: "child.tool" },
      { type: "await_run_status", targetRunIndex: 3, status: "completed" },
    ],
  };
}
