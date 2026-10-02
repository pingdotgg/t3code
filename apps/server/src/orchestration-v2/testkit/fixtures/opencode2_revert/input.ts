import {
  OPENCODE2_REVERT_FIRST_PROMPT,
  OPENCODE2_REVERT_SECOND_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/** Two turns that write the same file, then a rollback to the first. */
export function openCode2RevertInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_REVERT_FIRST_PROMPT },
      { type: "message", text: OPENCODE2_REVERT_SECOND_PROMPT },
      { type: "rollback", checkpointScopeSuffix: "root", checkpointSuffix: "1" },
      { type: "await_run_status", targetRunIndex: 2, status: "rolled_back" },
    ],
  };
}
