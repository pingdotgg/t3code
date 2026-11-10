import { SUBAGENT_V2_NESTED_APPROVAL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export const NESTED_SUBAGENT_APPROVAL_PENDING_SHELL_KEY = "nested-subagent-approval-pending";

export function subagentV2NestedApprovalInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: SUBAGENT_V2_NESTED_APPROVAL_PROMPT },
      {
        type: "approve_next_runtime_request",
        shellSnapshotKeyWhilePending: NESTED_SUBAGENT_APPROVAL_PENDING_SHELL_KEY,
      },
    ],
  };
}
