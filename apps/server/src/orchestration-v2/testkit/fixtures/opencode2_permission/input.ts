import { OPENCODE2_PERMISSION_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/** Supervised: the first command is approved, then it and the model's two retries are declined. */
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
