import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_STOP_HOOK_CONTINUATION_PROMPT =
  "Respond with exactly: STOP_HOOK_ANSWER. Then stop. If a Stop hook gives you feedback, follow it.";

/**
 * Recorded with a project `.claude/settings.json` Stop command hook that, on the
 * first stop only, prints `{"hookSpecificOutput":{"hookEventName":"Stop",
 * "additionalContext":"Reply with exactly: STOP_HOOK_REPLY"}}` and nothing else.
 */
export function claudeStopHookContinuationInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_STOP_HOOK_CONTINUATION_PROMPT }],
  };
}
