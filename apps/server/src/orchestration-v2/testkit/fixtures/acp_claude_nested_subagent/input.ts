import type { OrchestratorFixtureInput } from "../shared.ts";

const ACP_CLAUDE_NESTED_SUBAGENT_PROMPT = "Review the change in the background.";

// Claude Agent on ACP v2. After run 1 ended, the background subagent starts a
// subagent of its own, which claude-agent-acp announces on that subagent and
// whose output streams before Claude's follow-up.
export function acpClaudeNestedSubagentInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_NESTED_SUBAGENT_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
