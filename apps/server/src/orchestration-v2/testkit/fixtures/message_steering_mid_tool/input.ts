import {
  MESSAGE_STEERING_MID_TOOL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function messageSteeringMidToolInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: MESSAGE_STEERING_MID_TOOL_PROMPT },
      {
        type: "steer",
        text: MESSAGE_STEERING_STEER_PROMPT,
        targetRunIndex: 1,
        waitForTurnItemType: "command_execution",
      },
    ],
  };
}
