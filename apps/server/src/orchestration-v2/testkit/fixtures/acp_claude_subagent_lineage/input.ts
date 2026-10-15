import type { OrchestratorFixtureInput } from "../shared.ts";

const ACP_CLAUDE_SUBAGENT_LINEAGE_PROMPT = "Start two background subagents.";

// Claude Agent on ACP v2 links each child session to the Agent call that
// delegated to it, in either order claude-agent-acp sends them. Subagent A is
// announced, delegated to and already writing before its Agent call arrives.
// Subagent B's delegation arrives after run 1 ended. A session announced by a
// session nobody announced claims B's Agent call and writes too.
export function acpClaudeSubagentLineageInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_SUBAGENT_LINEAGE_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
