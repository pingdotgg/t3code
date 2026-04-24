import { TOOL_CALL_WRITE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function messageSteeringInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TOOL_CALL_WRITE_PROMPT },
      {
        type: "steer",
        text: "Actually, respond with exactly: steering fixture observed",
        targetRunIndex: 1,
      },
      { type: "approve_next_runtime_request" },
    ],
  };
}
