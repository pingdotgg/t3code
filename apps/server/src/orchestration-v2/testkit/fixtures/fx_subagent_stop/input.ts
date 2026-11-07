import { FX_SUBAGENT_STOP_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/**
 * Supervised: fx never forwards a sub-agent's permission request over ACP,
 * so the sub-agent waits until Stop.
 */
export function fxSubagentStopInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: FX_SUBAGENT_STOP_PROMPT },
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "subagent" },
    ],
  };
}
