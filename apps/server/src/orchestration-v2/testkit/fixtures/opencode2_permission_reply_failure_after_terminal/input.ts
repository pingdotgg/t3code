import { SIMPLE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2PermissionReplyFailureAfterTerminalInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: SIMPLE_PROMPT },
      { type: "approve_next_runtime_request", decision: "accept" },
      { type: "advance_clock", duration: "100 millis" },
    ],
  };
}
