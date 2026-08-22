import { SIMPLE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2PermissionDeclineInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: SIMPLE_PROMPT },
      { type: "approve_next_runtime_request", decision: "decline" },
      { type: "message", text: "Respond with the following text: fixture duplicate ok" },
    ],
  };
}
