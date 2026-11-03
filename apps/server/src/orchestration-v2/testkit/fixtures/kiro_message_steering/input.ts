import { MESSAGE_STEERING_STEER_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export const KIRO_MESSAGE_STEERING_PROMPT =
  "Run the shell command `sleep 5` once, then respond with exactly: steering fixture initial response";

/** The command keeps the turn running, so the steer lands before Kiro's last step. */
export function kiroMessageSteeringInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "full-access",
    steps: [
      { type: "message", text: KIRO_MESSAGE_STEERING_PROMPT },
      { type: "steer", text: MESSAGE_STEERING_STEER_PROMPT, targetRunIndex: 1 },
    ],
  };
}
