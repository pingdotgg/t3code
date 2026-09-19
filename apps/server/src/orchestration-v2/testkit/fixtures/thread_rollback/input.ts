import {
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function threadRollbackInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: THREAD_ROLLBACK_FIRST_PROMPT },
      { type: "message", text: THREAD_ROLLBACK_SECOND_PROMPT },
      {
        type: "rollback",
        checkpointScopeSuffix: "root",
        checkpointSuffix: "1",
      },
      { type: "message", text: THREAD_ROLLBACK_AFTER_PROMPT },
    ],
  };
}
