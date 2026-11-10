import { OPENCODE_SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export const OPENCODE_RUNNING_CHILD_APPROVAL_PENDING_SHELL_KEY =
  "opencode-running-child-approval-pending";

export function openCodeRunningChildApprovalInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE_SUBAGENT_PROMPT },
      {
        type: "approve_next_runtime_request",
        shellSnapshotKeyWhilePending: OPENCODE_RUNNING_CHILD_APPROVAL_PENDING_SHELL_KEY,
      },
    ],
  };
}
