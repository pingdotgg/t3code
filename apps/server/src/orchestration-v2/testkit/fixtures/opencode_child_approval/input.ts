import { OPENCODE_SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCodeChildApprovalInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE_SUBAGENT_PROMPT },
      { type: "approve_next_runtime_request" },
    ],
  };
}
