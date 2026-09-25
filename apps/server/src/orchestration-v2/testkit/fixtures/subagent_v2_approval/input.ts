import { SUBAGENT_V2_APPROVAL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export const SUBAGENT_APPROVAL_PENDING_SHELL_KEY = "subagent-approval-pending";

/** The adapter's approval-required turn policy, which the recording ran under. */
export const SUBAGENT_V2_APPROVAL_POLICY = {
  approvalPolicy: "untrusted",
  sandboxPolicy: { type: "readOnly" },
} as const;

export function subagentV2ApprovalInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: SUBAGENT_V2_APPROVAL_PROMPT },
      {
        type: "approve_next_runtime_request",
        shellSnapshotKeyWhilePending: SUBAGENT_APPROVAL_PENDING_SHELL_KEY,
      },
    ],
  };
}
