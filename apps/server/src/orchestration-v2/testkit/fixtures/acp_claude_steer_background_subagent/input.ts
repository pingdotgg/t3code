import type { OrchestratorFixtureInput } from "../shared.ts";

// Claude Agent on ACP v2. The user steers a run whose background subagent
// still works: a cancel, then the steered prompt in the same run.
export function acpClaudeSteerBackgroundSubagentInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: "Find the flaky test in the background." },
      { type: "steer", text: "Also check lint.", targetRunIndex: 1 },
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
    ],
  };
}
