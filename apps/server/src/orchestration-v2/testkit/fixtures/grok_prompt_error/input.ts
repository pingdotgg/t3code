import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_PROMPT_ERROR_PROMPT = "Respond with exactly: grok prompt error fixture";
export const GROK_PROMPT_ERROR_FOLLOW_UP =
  "Respond with exactly: grok prompt error fixture recovered";

export function grokPromptErrorInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_PROMPT_ERROR_PROMPT },
      { type: "message", text: GROK_PROMPT_ERROR_FOLLOW_UP },
    ],
  };
}
