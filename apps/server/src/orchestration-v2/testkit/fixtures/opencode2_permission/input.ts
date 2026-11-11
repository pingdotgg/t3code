import { OPENCODE2_PERMISSION_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2PermissionInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: OPENCODE2_PERMISSION_PROMPT },
      { type: "approve_next_runtime_request" },
      { type: "approve_next_runtime_request", decision: "decline" },
      { type: "approve_next_runtime_request", decision: "decline" },
      { type: "approve_next_runtime_request", decision: "decline" },
    ],
  };
}
