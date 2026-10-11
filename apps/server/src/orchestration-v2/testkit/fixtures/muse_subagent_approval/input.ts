import { SUBAGENT_V2_APPROVAL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/**
 * A Supervised Muse thread spawns a native subagent that runs a shell command.
 * The subagent's approval is asked in its child thread and approved there.
 */
export function museSubagentApprovalInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: SUBAGENT_V2_APPROVAL_PROMPT },
      { type: "approve_next_runtime_request" },
    ],
  };
}
