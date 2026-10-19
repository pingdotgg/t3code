import {
  CLAUDE_RESULT_IS_ERROR_FOLLOW_UP,
  CLAUDE_RESULT_IS_ERROR_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/**
 * Recorded from thread 47763f5e run 1 (2026-07-01): the SDK reports API-level
 * failures (401 auth, 529 overloaded, …) as a result with subtype "success" but
 * is_error: true, alongside a synthetic-model assistant message carrying the
 * error text.
 */
export function claudeResultIsErrorInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_RESULT_IS_ERROR_PROMPT },
      { type: "message", text: CLAUDE_RESULT_IS_ERROR_FOLLOW_UP },
    ],
  };
}
