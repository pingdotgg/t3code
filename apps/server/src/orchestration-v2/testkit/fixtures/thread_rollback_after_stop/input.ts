import {
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/**
 * Rolls back past a turn the user stopped mid-tool. Stop restarts the
 * provider runtime, so the stopped turn's native rollback point must be
 * captured before the process goes away.
 */
export function threadRollbackAfterStopInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: THREAD_ROLLBACK_FIRST_PROMPT },
      { type: "message", text: TURN_INTERRUPT_MID_TOOL_PROMPT },
      { type: "interrupt", targetRunIndex: 2, waitForTurnItemType: "command_execution" },
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
