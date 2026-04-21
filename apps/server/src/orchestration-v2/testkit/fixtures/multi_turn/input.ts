import type { OrchestratorFixtureInput } from "../shared.ts";

export function multiTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: "Respond with exactly: first fixture turn complete" },
      { type: "message", text: "Respond with exactly: second fixture turn complete" },
    ],
  };
}
