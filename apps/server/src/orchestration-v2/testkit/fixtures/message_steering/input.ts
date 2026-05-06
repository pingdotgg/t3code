import {
  MESSAGE_STEERING_STEER_PROMPT,
  TOOL_CALL_WRITE_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function messageSteeringInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TOOL_CALL_WRITE_PROMPT },
      {
        type: "steer",
        text: MESSAGE_STEERING_STEER_PROMPT,
        targetRunIndex: 1,
      },
      { type: "approve_next_runtime_request" },
    ],
  };
}
