import {
  OPENCODE2_CANCELLED_PROMPT,
  OPENCODE2_QUEUED_PROMPT,
  OPENCODE2_STEER_PROMPT,
  OPENCODE2_STEER_TEXT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/**
 * While the recorded shell call runs, two messages are queued (the second is
 * cancelled) and one is steered in. OpenCode reads the steer at the call's
 * step boundary; the queued message then runs as its own turn.
 */
export function openCode2InboxInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_STEER_PROMPT },
      { type: "queue_message", text: OPENCODE2_QUEUED_PROMPT },
      { type: "queue_message", text: OPENCODE2_CANCELLED_PROMPT },
      { type: "cancel_queued_run", targetRunIndex: 3 },
      { type: "steer", text: OPENCODE2_STEER_TEXT, targetRunIndex: 1 },
    ],
  };
}
