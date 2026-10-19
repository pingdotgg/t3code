import {
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/**
 * The idle gap outlasts ProviderSessionManager's 30-minute idle timeout, which
 * releases the provider session, as a server restart would.
 */
export function threadRollbackAfterRestartInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: THREAD_ROLLBACK_FIRST_PROMPT },
      { type: "message", text: THREAD_ROLLBACK_SECOND_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
      {
        type: "rollback",
        checkpointScopeSuffix: "root",
        checkpointSuffix: "1",
      },
      { type: "message", text: THREAD_ROLLBACK_AFTER_PROMPT },
    ],
  };
}
