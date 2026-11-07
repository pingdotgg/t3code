import { SUBAGENT_V2_APPROVAL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function museSubagentApprovalInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: SUBAGENT_V2_APPROVAL_PROMPT },
      { type: "approve_next_runtime_request" },
    ],
  };
}
