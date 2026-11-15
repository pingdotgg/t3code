import { MESSAGE_STEERING_STEER_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export const GROK_MESSAGE_STEERING_PROMPT =
  "Run the shell command `sleep 8 && echo FOREGROUND_DONE` once in the foreground, then respond with exactly: steering fixture initial response";

/** The steer lands while the foreground command runs, which the interjection must not cancel. */
export function grokMessageSteeringInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "full-access",
    steps: [
      { type: "message", text: GROK_MESSAGE_STEERING_PROMPT },
      {
        type: "steer",
        text: MESSAGE_STEERING_STEER_PROMPT,
        targetRunIndex: 1,
        waitForTurnItemType: "command_execution",
      },
    ],
  };
}
