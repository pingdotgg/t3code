import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_PROMPT_ERROR_PROMPT = "Respond with exactly: grok prompt error fixture";
export const GROK_PROMPT_ERROR_FOLLOW_UP =
  "Respond with exactly: grok prompt error fixture recovered";

/**
 * Recorded against a chat proxy that rejected the first model request, the way
 * Grok's backend answers an outdated CLI (thread d92481a2, 2026-09-30). Grok
 * reports that failure as `stopReason: "error"` on its prompt completion before
 * the `session/prompt` RPC error arrives, and the next prompt reaches the model.
 */
export function grokPromptErrorInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_PROMPT_ERROR_PROMPT },
      { type: "message", text: GROK_PROMPT_ERROR_FOLLOW_UP },
    ],
  };
}
