import type { OrchestratorFixtureInput } from "../shared.ts";

const KIRO_SUBAGENT_INTERRUPT_PROMPT =
  "Delegate this to one sub-agent with your sub-agent tool and run nothing yourself: the sub-agent must run the shell command `sleep 30` with its shell tool and then reply exactly: Done. Wait for it, then reply with exactly what it said.";

/** Stop lands while the sub-agent's command runs. */
export function kiroSubagentInterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: KIRO_SUBAGENT_INTERRUPT_PROMPT },
      {
        type: "interrupt",
        targetRunIndex: 1,
        waitForTurnItemType: "dynamic_tool",
        inSubagentThread: true,
      },
    ],
  };
}
