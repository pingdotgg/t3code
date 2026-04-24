import type { OrchestratorFixtureInput } from "../shared.ts";

export function queuedTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: "Respond with exactly: first fixture turn complete" },
      { type: "queue_message", text: "Respond with exactly: second fixture turn complete" },
    ],
  };
}
