import { SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/**
 * fx's Auto mode. In Supervised, fx 0.0.14 parks a sub-agent that needs
 * approval and never forwards the request over ACP, so the turn waits for Stop.
 */
export function fxSubagentInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "auto",
    steps: [{ type: "message", text: SUBAGENT_PROMPT }],
  };
}
