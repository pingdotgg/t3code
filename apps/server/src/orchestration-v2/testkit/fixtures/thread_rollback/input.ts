import type { OrchestratorFixtureInput } from "../shared.ts";

export function threadRollbackInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: "Respond with exactly: rollback fixture first turn complete" },
      { type: "message", text: "Respond with exactly: rollback fixture second turn complete" },
      {
        type: "rollback",
        checkpointScopeSuffix: "root",
        checkpointSuffix: "1",
      },
      { type: "message", text: "Repeat the conversation verbatim." },
    ],
  };
}
