import type { OrchestratorFixtureInput } from "../shared.ts";

const MUSE_SUBAGENT_INTERRUPT_PROMPT =
  "Spawn one subagent whose only task is to run the shell command `sleep 30` and then reply with exactly: Done. Wait for it to finish, then reply with exactly what it said.";

export function museSubagentInterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: MUSE_SUBAGENT_INTERRUPT_PROMPT },
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "subagent" },
    ],
  };
}
